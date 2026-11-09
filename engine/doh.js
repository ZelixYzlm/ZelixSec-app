'use strict';

/**
 * ZelixSec - DNS-over-HTTPS çözümleyici
 * -------------------------------------
 * Operatörlerin çoğu blokajı bozuk DNS cevabı ile uygular (discord.com ->
 * 127.0.0.1 / 10.x gibi). Bu modül A/AAAA kayıtlarını HTTPS üzerinden
 * (Cloudflare / Google / Quad9) çözer, böylece zehirli yerel DNS devre dışı
 * kalır. Sonuçlar TTL'e göre önbelleğe alınır (gecikme eklemez).
 */

const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const systemDns = require('node:dns').promises;

const PROVIDERS = {
  cloudflare: {
    label: 'Cloudflare (1.1.1.1)',
    hostname: 'cloudflare-dns.com',
    ip: '1.1.1.1',
    path: '/dns-query',
    json: true,
  },
  google: {
    label: 'Google (8.8.8.8)',
    hostname: 'dns.google',
    ip: '8.8.8.8',
    path: '/resolve',
    json: true,
  },
  quad9: {
    label: 'Quad9 (9.9.9.9)',
    hostname: 'dns.quad9.net',
    ip: '9.9.9.9',
    path: '/dns-query',
    json: true,
  },
  system: {
    label: 'Sistem DNS (DoH kapalı)',
    system: true,
  },
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MIN_TTL_MS = 30 * 1000;

function normalizeProvider(name) {
  return PROVIDERS[name] ? name : 'cloudflare';
}

/**
 * Tek bir HTTPS isteği ile JSON DNS cevabı alır.
 * SNI doğru gönderilsin diye hostname yerine sabit IP'ye bağlanıp
 * servername ile sertifika doğrulaması yapılır (DNS zehirlenmesine bağışık).
 */
function queryJson(provider, name, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const qs = `?name=${encodeURIComponent(name)}&type=${type}`;
    const req = https.request(
      {
        host: provider.ip,
        port: 443,
        servername: provider.hostname,
        method: 'GET',
        path: provider.path + qs,
        headers: {
          accept: 'application/dns-json',
          'user-agent': 'ZelixSec/1.0',
        },
        timeout: timeoutMs,
        // IP'ye bağlandığımız için sertifikayı hostname'e göre doğrula
        checkServerIdentity: (_host, cert) => tls.checkServerIdentity(provider.hostname, cert),
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 64 * 1024) req.destroy(new Error('DoH cevabı çok büyük'));
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`DoH HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error('DoH cevabı ayrıştırılamadı'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('DoH zaman aşımı')));
    req.on('error', reject);
    req.end();
  });
}

class DohResolver {
  /**
   * @param {object} opts
   * @param {string} [opts.provider]  'cloudflare' | 'google' | 'quad9' | 'system'
   * @param {boolean} [opts.enabled]  DoH kullanılsın mı
   * @param {boolean} [opts.allowSystemFallback] DoH başarısızsa sistem DNS'i denensin mi
   * @param {number} [opts.timeoutMs]
   */
  constructor(opts = {}) {
    this.provider = normalizeProvider(opts.provider || 'cloudflare');
    this.enabled = opts.enabled !== false;
    this.allowSystemFallback = opts.allowSystemFallback !== false;
    this.timeoutMs = opts.timeoutMs || 4000;
    this.cache = new Map(); // `${name}|${type}` -> { ips, expires }
    this.stats = { hits: 0, misses: 0, errors: 0 };
  }

  configure(opts = {}) {
    if (opts.provider) this.provider = normalizeProvider(opts.provider);
    if (typeof opts.enabled === 'boolean') this.enabled = opts.enabled;
    if (typeof opts.allowSystemFallback === 'boolean') this.allowSystemFallback = opts.allowSystemFallback;
    if (Number.isFinite(opts.timeoutMs)) this.timeoutMs = opts.timeoutMs;
    this.cache.clear();
  }

  clearCache() {
    this.cache.clear();
  }

  /** Önbellekten taze kayıt döndürür veya null. */
  fromCache(name, type) {
    const key = `${name}|${type}`;
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expires < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    this.stats.hits += 1;
    return entry.ips;
  }

  store(name, type, ips, ttlSeconds) {
    const ttl = Math.max(MIN_TTL_MS, Math.min(ttlSeconds * 1000 || DEFAULT_TTL_MS, 30 * 60 * 1000));
    this.cache.set(`${name}|${type}`, { ips, expires: Date.now() + ttl });
  }

  async queryType(name, type) {
    const key = `${name}|${type}`;
    if (this.cache.has(key)) {
      const cached = this.fromCache(name, type);
      if (cached) return cached;
    }
    this.stats.misses += 1;

    if (!this.enabled || PROVIDERS[this.provider].system) {
      return this.systemResolve(name, type);
    }

    const provider = PROVIDERS[this.provider];
    let json;
    try {
      json = await queryJson(provider, name, type, this.timeoutMs);
    } catch (err) {
      this.stats.errors += 1;
      if (this.allowSystemFallback) return this.systemResolve(name, type);
      throw err;
    }

    const answers = Array.isArray(json.Answer) ? json.Answer : [];
    // CNAME zincirini atlayıp istediğimiz tipteki kayıtları topla
    const ips = answers
      .filter((a) => (type === 'A' ? a.type === 1 : a.type === 28))
      .map((a) => a.data)
      .filter((ip) => net.isIP(ip));

    if (ips.length === 0) {
      if (this.allowSystemFallback) return this.systemResolve(name, type);
      throw new Error(`${name} için ${type} kaydı bulunamadı`);
    }

    const ttl = answers.reduce((min, a) => Math.min(min, Number(a.TTL) || 60), 600);
    this.store(name, type, ips, ttl);
    return ips;
  }

  async systemResolve(name, type) {
    const records = await systemDns.resolve(name, type);
    if (!records || records.length === 0) throw new Error(`${name} çözümlenemedi`);
    this.store(name, type, records, 60);
    return records;
  }

  /**
   * Host adını IPv4 + IPv6 listesine çevirir. Host zaten IP ise dokunmaz.
   * IPv4 önceliklidir; IPv6 sadece yoksa kullanılır.
   */
  async resolve(host) {
    if (net.isIP(host)) return [host];
    const v4 = await this.queryType(host, 'A').catch(() => []);
    if (v4.length > 0) return v4;
    return this.queryType(host, 'AAAA');
  }
}

module.exports = { DohResolver, PROVIDERS, normalizeProvider };
