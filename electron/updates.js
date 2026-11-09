'use strict';

/**
 * ZelixSec - Güncelleme servisi
 * -----------------------------
 * Uzak sunucuda barındırılan küçük bir JSON manifest ("update.json")
 * okur; yeni sürüm var mı diye bakar, istenirse kurulum dosyasını
 * indirir ve NSIS kurulumunu sessiz (/S) başlatır.
 *
 * Beklenen manifest biçimi:
 *   {
 *     "latest": "1.0.3",
 *     "notes":  "Yenilikler…",
 *     "url":    "https://.../ZelixSec-Setup-1.0.3.exe",   (exe doğrudan bağlantı)
 *     "sha256": "opsiyonel, bütünlük kontrolü",
 *     "publishedAt": "2026-01-02"
 *   }
 *
 * Test edilebilirlik için bu modül Electron'a bağımlı değildir;
 * pencere tazeleme/uygulama kapanışı ana süreç (main.js) elindedir.
 */

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

/**
 * Varsayılan manifest adresi. "Ayarlar → Güncelleme" bölümünden
 * keyfim kendi sunucunca veya GitHub raw ile değiştirilebilir.
 */
const DEFAULT_UPDATE_URL = 'https://raw.githubusercontent.com/ZelixYzlm/ZelixSec-app/main/update.json';

const MAX_REDIRECTS = 5;
const MAX_JSON_BYTES = 512 * 1024;

/* --------------------------------------------------------------- http yardımcı */

function requestOnce(url, { timeoutMs = 15000 } = {}, cb) {
  let u;
  try {
    u = new URL(url);
  } catch (err) {
    return setImmediate(() => cb(new Error(`geçersiz URL: ${url}`)));
  }
  if (u.protocol !== 'https:') return setImmediate(() => cb(new Error('yalnızca https bağlantısı desteklenir')));
  const req = https.request(
    {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'user-agent': 'ZelixSec-Update/1.0', accept: '*/*' },
      timeout: timeoutMs,
    },
    (res) => cb(null, res),
  );
  req.on('timeout', () => req.destroy(new Error('zaman aşımı')));
  req.on('error', (err) => cb(err));
  req.end();
}

function followRedirects(url, cb, count = 0) {
  if (count > MAX_REDIRECTS) return cb(new Error('çok fazla yönlendirme'));
  requestOnce(url, {}, (err, res) => {
    if (err) return cb(err);
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      return followRedirects(new URL(res.headers.location, url).toString(), cb, count + 1);
    }
    cb(null, res);
  });
}

/** Küçük JSON gövdesi indirip ayrıştırır (redirect takip eder). */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    followRedirects(url, (err, res) => {
      if (err) return reject(err);
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`manifest HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > MAX_JSON_BYTES) {
          res.destroy(new Error('manifest çok büyük'));
        }
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed || typeof parsed !== 'object') throw new Error('manifest JSON değil');
          resolve(parsed);
        } catch (parseErr) {
          reject(new Error(`manifest ayrıştırılamadı: ${parseErr.message}`));
        }
      });
    });
  });
}

/** Kurulum dosyasını dosya ya?dosyaya indir; SHA-256 doğrulaması opsiyonel. */
function downloadFile(url, dest, { onProgress, expectedSha256, idleTimeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let inactivity = null;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      if (inactivity) clearTimeout(inactivity);
      reject(err);
    };
    const armIdle = (stream) => {
      if (inactivity) clearTimeout(inactivity);
      inactivity = setTimeout(() => stream.destroy(new Error('indirme durakladı')), idleTimeoutMs);
    };

    followRedirects(url, (err, res) => {
      if (err) return fail(err);
      if (res.statusCode !== 200) {
        res.resume();
        return fail(new Error(`indirme HTTP ${res.statusCode}`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      let lastEmit = 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(dest);
      out.on('error', fail);
      res.on('error', fail);
      res.on('data', (chunk) => {
        got += chunk.length;
        hash.update(chunk);
        armIdle(res);
        if (onProgress && Date.now() - lastEmit > 150) {
          lastEmit = Date.now();
          try {
            onProgress(got, total);
          } catch {
            /* dinleyici hatası indirmeyi bozmasın */
          }
        }
      });
      out.on('finish', () => {
        if (failed) return;
        if (inactivity) clearTimeout(inactivity);
        const digest = hash.digest('hex');
        if (expectedSha256 && digest.toLowerCase() !== String(expectedSha256).toLowerCase()) {
          return fail(new Error('SHA-256 doğrulaması başarısız (dosya bozuk olabilir)'));
        }
        resolve({ bytes: got, sha256: digest });
      });
      armIdle(res);
      res.pipe(out);
    });
  });
}

/* ------------------------------------------------------------- sürüm kıyası */

function versionParts(value) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => String(parseInt(part, 10) || 0));
}

function isNewer(candidate, current) {
  const a = versionParts(candidate);
  const b = versionParts(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = Number(a[i] || 0);
    const y = Number(b[i] || 0);
    if (x !== y) return x > y;
  }
  return false;
}

function sanitizeName(value) {
  return String(value || '').replace(/[^\w.-]/g, '_').slice(0, 64) || 'guncelleme';
}

/* ---------------------------------------------------------------- servis */

class UpdateService extends EventEmitter {
  /** @param {object} opts currentVersion, tempDir, manifestUrl */
  constructor(opts = {}) {
    super();
    this.currentVersion = String(opts.currentVersion || '0.0.0');
    this.tempDir = opts.tempDir || os.tmpdir();
    this.manifestUrl = String(opts.manifestUrl || DEFAULT_UPDATE_URL).trim() || DEFAULT_UPDATE_URL;
    this.phase = 'idle'; // idle | checking | up-to-date | available | error | downloading | ready | installing
    this.error = null;
    this.latest = null;
    this.notes = '';
    this.downloadUrl = null;
    this.expectedSha256 = null;
    this.publishedAt = null;
    this.checkedAt = null;
    this.progress = { received: 0, total: 0, percent: 0 };
    this.file = null;
  }

  configure({ manifestUrl } = {}) {
    if (manifestUrl) this.manifestUrl = String(manifestUrl).trim() || DEFAULT_UPDATE_URL;
  }

  getStatus() {
    return {
      phase: this.phase,
      currentVersion: this.currentVersion,
      latest: this.latest,
      notes: this.notes,
      downloadUrl: this.downloadUrl,
      manifestUrl: this.manifestUrl,
      checkedAt: this.checkedAt,
      publishedAt: this.publishedAt,
      progress: { ...this.progress },
      file: this.file,
      error: this.error,
    };
  }

  publish() {
    this.emit('status', this.getStatus());
    return this.getStatus();
  }

  say(message, level = 'info') {
    this.emit('log', { level, message });
  }

  /** Sunucudaki manifest'e bakar; manual ise hata fırlatır, otomatik çekim sessizdir. */
  async check(manual = false) {
    this.phase = 'checking';
    this.error = null;
    this.publish();
    try {
      const manifest = await fetchJson(this.manifestUrl);
      const latest = String(manifest.latest || manifest.version || manifest.tag || '').trim();
      if (!latest) throw new Error('manifest: sürüm alanı (latest) eksik');
      this.latest = latest;
      this.notes = String(manifest.notes || manifest.description || '');
      this.downloadUrl = manifest.url || manifest.download || manifest.installer || null;
      this.expectedSha256 = manifest.sha256 || null;
      this.publishedAt = manifest.publishedAt || manifest.date || null;
      this.checkedAt = new Date().toISOString();
      if (isNewer(latest, this.currentVersion)) {
        this.phase = 'available';
        this.say(`Yeni sürüm tespit edildi: ${latest} (kurulu: ${this.currentVersion})`);
      } else {
        this.phase = 'up-to-date';
        this.say(`Sürüm güncel: ${this.currentVersion}`);
      }
    } catch (err) {
      this.phase = 'error';
      this.error = err.message;
      this.say(`Manifest okunamadı: ${err.message}`, 'warn');
      if (manual) throw err;
    }
    return this.publish();
  }

  /** Kurulum dosyasını indirip "ready" fazına geçer. */
  async downloadAndPrepare() {
    if (this.phase !== 'available') throw new Error('indirilecek güncelleme yok');
    if (!this.downloadUrl) throw new Error('manifestte indirme adresi (url) yok');
    this.phase = 'downloading';
    this.error = null;
    this.progress = { received: 0, total: 0, percent: 0 };
    this.file = null;
    this.publish();

    const dest = path.join(this.tempDir, `ZelixSec-Setup-${sanitizeName(this.latest)}.exe`);
    try {
      fs.rmSync(dest, { force: true });
    } catch {
      /* eski dosya silinemedi; üzerine yazılır */
    }
    try {
      const { bytes } = await downloadFile(this.downloadUrl, dest, {
        expectedSha256: this.expectedSha256 || undefined,
        onProgress: (received, total) => {
          this.progress = {
            received,
            total: total || this.progress.total,
            percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0,
          };
          this.emit('progress', this.progress);
        },
      });
      this.file = dest;
      this.phase = 'ready';
      this.say(`Kurulum indirildi (${(bytes / 1048576).toFixed(1)} MB)`);
    } catch (err) {
      this.phase = 'error';
      this.error = err.message;
      this.say(`İndirme başarısız: ${err.message}`, 'error');
    }
    this.publish();
    if (this.phase === 'error') throw new Error(this.error);
    return { file: this.file };
  }

  /** İndirilmiş kurulumu sessiz modda başlatır; ana süreç uygulama kapatabilir. */
  async install() {
    if (this.phase === 'available') await this.downloadAndPrepare();
    if (this.phase !== 'ready' || !this.file) throw new Error('indirilmiş kurulum dosyası yok');
    this.phase = 'installing';
    this.publish();
    const child = spawn(this.file, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    this.say('Kurulum başlatıldı (sessiz mod)');
    return { file: this.file };
  }
}

module.exports = { UpdateService, DEFAULT_UPDATE_URL, isNewer, compareVersions: isNewer };
