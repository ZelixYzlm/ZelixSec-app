'use strict';

/**
 * ZelixSec - Paket Parçalama Motoru (yerel ağ geçidi)
 * ==================================================
 * Tek bir yerel HTTP proxy dinler. Uygulamalar (Discord, Roblox, tarayıcı)
 * sisteme vekil sunucu olarak 127.0.0.1:<port> verildiğinde tüm trafik buradan
 * geçer ve ilk TCP segmenti (TLS ClientHello) ikiye bölünerek DPI atlanır.
 *
 * Neden işe yarar?
 *  - DPI cihazları SNI/host imzasını tek segmentte arar; iki segmentte
 *    bulamayınca bağlantıyı kesmez.
 *  - DNS sorguları DoH ile yapılır (zehirli yerel DNS devre dışı).
 *  - İsteğe bağlı yukarı akış (SOCKS5 / HTTP) zinciri ile IP tabanlı
 *    blokajlarda trafik başka bir çıkıştan geçirilebilir.
 *
 * Kernel sürücüsü (WinDivert) GEREKTİRMEZ: her şey kullanıcı alanında,
 * normal TCP soketleriyle yapılır. Bu yüzden kurulum/derleme derdi yoktur.
 */

const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { DohResolver } = require('./doh');
const { AdBlocker } = require('./adblock');
const {
  looksLikeClientHello,
  clientHelloComplete,
  planSplit,
  planHttpSplit,
} = require('./tls-split');

const MAX_HELLO_BYTES = 32 * 1024;
const HELLO_WAIT_MS = 120;
const CONNECT_TIMEOUT_MS = 10_000;

function parseAuthority(authority, fallbackPort) {
  // "host:port" | "[::1]:443" | "host"
  const value = String(authority || '').trim();
  if (!value) return null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return null;
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : fallbackPort;
    return { host, port: Number.isFinite(port) && port > 0 ? port : fallbackPort };
  }
  const idx = value.lastIndexOf(':');
  if (idx > 0 && value.indexOf(':') === idx) {
    const host = value.slice(0, idx);
    const port = Number(value.slice(idx + 1));
    return { host, port: Number.isFinite(port) && port > 0 ? port : fallbackPort };
  }
  return { host: value, port: fallbackPort };
}

function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** SOCKS5 tüneli açar (kimlik doğrulamalı veya anonim). */
function connectSocks5(opts) {
  const { targetHost, targetPort, proxyHost, proxyPort, username, password, timeout } = opts;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error('SOCKS5 zaman aşımı')), timeout);

    function fail(err) {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    }
    function done() {
      clearTimeout(timer);
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      resolve(socket);
    }

    socket.setNoDelay(true);
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('SOCKS5 sunucusu bağlantıyı kapattı')));
    socket.on('connect', () => {
      const withAuth = Boolean(username || password);
      socket.write(Buffer.from(withAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        const method = buffer[1];
        buffer = buffer.subarray(2);
        if (method === 0x02) {
          const u = Buffer.from(username || '', 'utf8');
          const p = Buffer.from(password || '', 'utf8');
          const auth = Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]);
          socket.write(auth);
          stage = 'auth';
          return;
        }
        if (method !== 0x00) return fail(new Error('SOCKS5: desteklenen kimlik doğrulama yok'));
        stage = 'connect';
        sendConnect();
        return;
      }

      if (stage === 'auth') {
        if (buffer.length < 2) return;
        if (buffer[1] !== 0x00) return fail(new Error('SOCKS5: kimlik doğrulama başarısız'));
        buffer = buffer.subarray(2);
        stage = 'connect';
        sendConnect();
        return;
      }

      if (stage === 'reply') {
        if (buffer.length < 5) return;
        if (buffer[0] !== 0x05) return fail(new Error('SOCKS5: geçersiz cevap'));
        if (buffer[1] !== 0x00) return fail(new Error(`SOCKS5 hata kodu ${buffer[1]}`));
        const atyp = buffer[3];
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : buffer[4] + 1;
        if (buffer.length < 4 + addrLen + 2) return;
        done();
      }
    });

    function sendConnect() {
      stage = 'reply';
      const hostBuf = Buffer.from(targetHost, 'utf8');
      const request = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
      ]);
      socket.write(request);
    }
  });
}

/** Yukarı akış HTTP proxy üzerinden CONNECT tüneli açar. */
function connectHttpProxy(opts) {
  const { targetHost, targetPort, proxyHost, proxyPort, username, password, timeout } = opts;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => fail(new Error('HTTP vekil zaman aşımı')), timeout);

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    }
    function done() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      resolve(socket);
    }

    socket.setNoDelay(true);
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('Vekil sunucu bağlantıyı kapattı')));
    socket.on('connect', () => {
      const auth =
        username || password
          ? `Proxy-Authorization: Basic ${Buffer.from(`${username || ''}:${password || ''}`).toString('base64')}\r\n`
          : '';
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}Proxy-Connection: keep-alive\r\n\r\n`,
      );
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > 16 * 1024) fail(new Error('Vekil cevabı çok büyük'));
        return;
      }
      const head = buffer.subarray(0, end).toString('latin1');
      const status = Number((head.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]);
      if (!status) return fail(new Error('Vekil cevabı ayrıştırılamadı'));
      if (status !== 200) return fail(new Error(`Vekil CONNECT reddetti (HTTP ${status})`));
      const leftover = buffer.subarray(end + 4);
      if (leftover.length) socket.unshift(leftover);
      done();
    });
  });
}

class DesyncProxy extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = {
      host: '127.0.0.1',
      port: 7717,
      mode: 'split2',
      splitPosition: 1,
      splitDelayMs: 0,
      allowlist: [], // boş = tüm hostlar
      doh: {
        enabled: true,
        provider: 'cloudflare',
        allowSystemFallback: true,
      },
      adblock: {
        enabled: false,
        customBlocked: [],
      },
      upstream: {
        enabled: false,
        type: 'socks5',
        host: '127.0.0.1',
        port: 1080,
        username: '',
        password: '',
      },
      ...options,
    };
    this.doh = new DohResolver(this.config.doh);
    this.adblock = new AdBlocker(this.config.adblock);
    this.blockedHosts = new Map(); // host -> { count, lastAt } (reklam engellenenler)
    this.server = null;
    this.running = false;
    this.sockets = new Set();
    this.metrics = {
      connections: 0,
      active: 0,
      failures: 0,
      suspiciousResets: 0,
      bytesUp: 0,
      bytesDown: 0,
      adsBlocked: 0,
      startedAt: null,
      lastError: null,
    };
    this.hosts = new Map(); // host -> { count, lastAt, resets }
  }

  log(level, message, extra) {
    this.emit('log', { level, message, at: Date.now(), ...extra });
  }

  configure(next = {}) {
    const merged = { ...this.config, ...next };
    merged.doh = { ...this.config.doh, ...(next.doh || {}) };
    merged.adblock = { ...this.config.adblock, ...(next.adblock || {}) };
    merged.upstream = { ...this.config.upstream, ...(next.upstream || {}) };
    if (Array.isArray(next.allowlist)) {
      merged.allowlist = next.allowlist.map(normalizeHost).filter(Boolean);
    }
    this.config = merged;
    this.doh.configure(this.config.doh);
    this.adblock.configure(this.config.adblock);
    this.log('info', 'Ayarlar güncellendi', { config: this.publicConfig() });
    return this.publicConfig();
  }

  publicConfig() {
    const { upstream, ...rest } = this.config;
    return {
      ...rest,
      upstream: { ...upstream, password: upstream.password ? '***' : '' },
    };
  }

  /** Host, parçalama listesinde mi? Liste boşsa her yer dahildir. */
  isTarget(host) {
    const h = normalizeHost(host);
    if (!this.config.allowlist.length) return true;
    return this.config.allowlist.some((entry) => h === entry || h.endsWith(`.${entry}`));
  }

  async start() {
    if (this.running) return this.getStatus();

    const server = http.createServer((req, res) => this.handlePlainHttp(req, res));
    server.on('connect', (req, socket, head) => this.handleConnect(req, socket, head));
    server.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      this.log('warn', `İstemci hatası: ${err.code || err.message}`);
    });
    server.on('upgrade', (req, socket, head) => {
      // WebSocket (ws://): elle kurulan istek hattı korunarak aktarılır
      let target = null;
      try {
        const url = new URL(req.url);
        target = { host: url.hostname, port: Number(url.port) || 80 };
      } catch {
        target = parseAuthority(req.url, 80);
      }
      if (!target) return socket.destroy();
      this.establishTunnel(socket, target.host, target.port, head, 'ws', req);
    });

    const listen = (port) =>
      new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, this.config.host);
      });

    let port = this.config.port;
    try {
      await listen(port);
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      this.log('warn', `${port} dolu, boş port aranıyor...`);
      await listen(0);
    }

    this.server = server;
    this.running = true;
    this.metrics.startedAt = Date.now();
    this.metrics.connections = 0;
    this.metrics.active = 0;
    this.metrics.failures = 0;
    this.metrics.suspiciousResets = 0;
    this.metrics.bytesUp = 0;
    this.metrics.bytesDown = 0;
    this.metrics.adsBlocked = 0;
    this.hosts.clear();
    this.blockedHosts.clear();

    const actualPort = server.address().port;
    this.config.port = actualPort;
    this.log('info', `Dinleniyor: ${this.config.host}:${actualPort}`, {
      mode: this.config.mode,
      doh: this.config.doh.enabled ? this.config.doh.provider : 'kapalı',
    });
    return this.getStatus();
  }

  async stop() {
    if (!this.running) return this.getStatus();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.running = false;
    this.doh.clearCache();
    this.log('info', 'Motor durduruldu');
    return this.getStatus();
  }

  getStatus() {
    return {
      running: this.running,
      host: this.config.host,
      port: this.config.port,
      mode: this.config.mode,
      doh: { ...this.config.doh },
      upstream: {
        enabled: this.config.upstream.enabled,
        type: this.config.upstream.type,
        host: this.config.upstream.host,
        port: this.config.upstream.port,
      },
      metrics: { ...this.metrics },
      hosts: Array.from(this.hosts.entries())
        .map(([host, info]) => ({ host, ...info }))
        .sort((a, b) => b.lastAt - a.lastAt)
        .slice(0, 25),
      adblock: {
        enabled: Boolean(this.config.adblock?.enabled),
        blocked: this.metrics.adsBlocked,
        counts: this.adblock.counts(),
        hosts: Array.from(this.blockedHosts.entries())
          .map(([host, info]) => ({ host, ...info }))
          .sort((a, b) => b.lastAt - a.lastAt)
          .slice(0, 15),
      },
      config: this.publicConfig(),
    };
  }

  track(host) {
    const key = normalizeHost(host);
    const info = this.hosts.get(key) || { count: 0, lastAt: 0, resets: 0 };
    info.count += 1;
    info.lastAt = Date.now();
    this.hosts.set(key, info);
  }

  trackBlocked(host) {
    const key = normalizeHost(host);
    const info = this.blockedHosts.get(key) || { count: 0, lastAt: 0 };
    info.count += 1;
    info.lastAt = Date.now();
    this.blockedHosts.set(key, info);
  }

  clearAdBlockStats() {
    this.metrics.adsBlocked = 0;
    this.blockedHosts.clear();
  }

  handleConnect(req, clientSocket, head) {
    const target = parseAuthority(req.url, 443);
    if (!target) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    this.establishTunnel(clientSocket, target.host, target.port, head, 'tls');
  }

  handlePlainHttp(req, res) {
    let target;
    try {
      const url = new URL(req.url);
      target = { host: url.hostname, port: Number(url.port) || 80 };
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ZelixSec: geçersiz istek');
      return;
    }
    // Yanıtı ham sokete yazacağız; res nesnesini kullanmıyoruz.
    this.establishTunnel(res.socket, target.host, target.port, null, 'http', req);
  }

  /** Asıl tünel kurulumu + parçalı aktarım. */
  async establishTunnel(clientSocket, host, port, head, kind, req) {
    this.metrics.connections += 1;
    this.metrics.active += 1;
    this.sockets.add(clientSocket);
    clientSocket.setNoDelay(true);
    clientSocket.on('close', () => {
      this.metrics.active = Math.max(0, this.metrics.active - 1);
      this.sockets.delete(clientSocket);
    });
    clientSocket.on('error', () => {});

    // Reklam / izleyici engeli: bağlantı hiç açılmadan reddedilir.
    if (this.adblock.enabled && this.adblock.blocks(host)) {
      this.metrics.adsBlocked += 1;
      this.trackBlocked(host);
      this.log('info', `Reklam engellendi: ${host}`);
      if (kind === 'http') {
        if (clientSocket.writable && !clientSocket.destroyed) {
          clientSocket.end(
            'HTTP/1.1 403 Blocked by ZelixSec\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\nReklam engellendi (ZelixSec)\n',
          );
        }
      } else if (clientSocket.writable && !clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 403 Blocked by ZelixSec\r\n\r\n');
        setTimeout(() => clientSocket.destroy(), 100);
      } else {
        clientSocket.destroy();
      }
      return;
    }

    const startedAt = Date.now();
    let upstreamSocket;
    try {
      upstreamSocket = await this.openUpstream(host, port);
    } catch (err) {
      this.metrics.failures += 1;
      this.metrics.lastError = `${host}:${port} -> ${err.message}`;
      this.log('error', `Bağlantı kurulamadı: ${host}:${port} (${err.message})`);
      if (kind === 'http' && clientSocket.writable && !clientSocket.destroyed) {
        clientSocket.end(
          'HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\nZelixSec: hedefe ulaşılamadı',
        );
      } else if (clientSocket.writable && !clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      return;
    }

    // İstemciye tünelin açıldığını bildir (tarayıcı/uygulama bunu bekler).
    // WebSocket'te 101 cevabını hedef sunucu verir, bu yüzden atlanır.
    if (kind === 'tls' && clientSocket.writable && !clientSocket.destroyed) {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: ZelixSec\r\n\r\n');
    }

    this.track(host);
    this.sockets.add(upstreamSocket);
    upstreamSocket.setNoDelay(true);
    upstreamSocket.on('close', () => this.sockets.delete(upstreamSocket));
    upstreamSocket.on('error', () => this.sockets.delete(upstreamSocket));

    // Sunucu tarafı bağlantıyı hemen sıfırlarsa bunu "DPI şüphesi" olarak işaretle
    upstreamSocket.on('close', () => {
      if (Date.now() - startedAt < 1500) {
        const key = normalizeHost(host);
        const info = this.hosts.get(key);
        if (info) info.resets += 1;
        this.metrics.suspiciousResets += 1;
      }
    });

    const useSplit = this.isTarget(host);
    this.log(
      'info',
      `${kind === 'http' ? 'HTTP' : 'TLS'} tünel: ${host}:${port}` +
        (useSplit ? ` [${this.config.mode}]` : ' [bölmesiz]'),
    );

    // Sunucudan gelen veriyi istemciye aktar
    upstreamSocket.on('data', (chunk) => {
      this.metrics.bytesDown += chunk.length;
      if (clientSocket.writable) clientSocket.write(chunk);
    });
    upstreamSocket.on('end', () => {
      if (clientSocket.writable) clientSocket.end();
    });

    // WebSocket: başlıkları olduğu gibi koruyup (Connection: Upgrade dahil) aktar
    if (kind === 'ws' && req) {
      const url = new URL(req.url);
      const headerLines = Object.entries(req.headers)
        .filter(([key]) => key !== 'proxy-connection')
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        .join('\r\n');
      const headBuffer = Buffer.from(
        `${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headerLines}\r\n\r\n`,
        'latin1',
      );
      this.metrics.bytesUp += headBuffer.length;
      this.writeSplit(upstreamSocket, headBuffer, useSplit);
      if (head && head.length) upstreamSocket.write(head);

      clientSocket.on('data', (chunk) => {
        this.metrics.bytesUp += chunk.length;
        if (upstreamSocket.writable) upstreamSocket.write(chunk);
      });
      clientSocket.on('end', () => {
        if (upstreamSocket.writable) upstreamSocket.end();
      });
      clientSocket.on('close', () => {
        if (!upstreamSocket.destroyed) upstreamSocket.destroy();
      });
      upstreamSocket.on('close', () => {
        if (!clientSocket.destroyed) clientSocket.destroy();
      });
      return;
    }

    // Düz HTTP: başlığı kendimiz yeniden yazıp bölerek gönderiyoruz
    if (kind === 'http' && req) {
      const url = new URL(req.url);
      const headerLines = Object.entries(req.headers)
        .filter(([key]) => !['proxy-connection', 'connection', 'keep-alive', 'transfer-encoding'].includes(key))
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        .join('\r\n');
      const head = Buffer.from(
        `${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headerLines}\r\nConnection: close\r\n\r\n`,
        'latin1',
      );
      this.metrics.bytesUp += head.length;
      this.writeSplit(upstreamSocket, head, useSplit);

      // ÖNEMLİ: gövde bittiğinde soketi KAPATMIYORUZ. Normal istemciler gibi
      // yanıtı bekliyoruz; erken FIN gönderen bağlantıları bazı sunucular
      // (ör. Cloudflare kenarı) iptal sayıp sıfırlıyor.
      if (!req.readableEnded) {
        req.on('data', (chunk) => {
          this.metrics.bytesUp += chunk.length;
          if (upstreamSocket.writable) upstreamSocket.write(chunk);
        });
      }
      req.on('error', () => upstreamSocket.destroy());
      req.on('aborted', () => upstreamSocket.destroy());
      return;
    }

    // TLS / WebSocket: ilk segment bölünür, sonrası doğrudan akar
    this.pipeWithSplit(clientSocket, upstreamSocket, useSplit, head);
  }

  /**
   * İstemciden gelen ilk veriyi (ClientHello) biriktirir, bölme planını
   * uygular ve iki ayrı TCP segmenti olarak sunucuya yazar.
   */
  pipeWithSplit(clientSocket, upstreamSocket, useSplit, head) {
    let pending = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    let flushed = false;
    let waitTimer = null;

    const flush = () => {
      if (flushed) return;
      flushed = true;
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = null;
      const data = pending;
      pending = Buffer.alloc(0);
      if (data.length === 0) return;
      this.writeSplit(upstreamSocket, data, useSplit);
    };

    const onData = (chunk) => {
      this.metrics.bytesUp += chunk.length;
      if (flushed) {
        if (upstreamSocket.writable) upstreamSocket.write(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      const isTls = looksLikeClientHello(pending);
      if (isTls && !clientHelloComplete(pending) && pending.length < MAX_HELLO_BYTES) {
        // ClientHello birden fazla segmentte gelmiş olabilir; tamamlanmasını bekle
        if (!waitTimer) waitTimer = setTimeout(flush, HELLO_WAIT_MS);
        return;
      }
      flush();
    };

    clientSocket.on('data', onData);
    clientSocket.on('end', () => {
      flush();
      if (upstreamSocket.writable) upstreamSocket.end();
    });
    clientSocket.on('close', () => {
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    });
    upstreamSocket.on('close', () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
    });

    if (pending.length) {
      const isTls = looksLikeClientHello(pending);
      if (!isTls || clientHelloComplete(pending)) flush();
      else waitTimer = setTimeout(flush, HELLO_WAIT_MS);
    }
  }

  /** Bölme planını uygulayıp iki ayrı yazma ile gönderir. */
  writeSplit(socket, buffer, useSplit) {
    if (!socket.writable || socket.destroyed) return;
    if (!useSplit || buffer.length < 2) {
      socket.write(buffer);
      return;
    }

    const isTls = looksLikeClientHello(buffer);
    const plan = isTls
      ? planSplit(buffer, this.config.mode, this.config.splitPosition)
      : planHttpSplit(buffer);

    if (plan.parts.length < 2) {
      socket.write(buffer);
      return;
    }

    const [first, second] = plan.parts;
    socket.write(first);
    const delay = Math.max(0, Number(this.config.splitDelayMs) || 0);
    if (delay > 0) {
      setTimeout(() => {
        if (socket.writable && !socket.destroyed) socket.write(second);
      }, delay);
    } else {
      socket.write(second);
    }

    this.emit('split', {
      mode: plan.mode,
      offset: plan.offset,
      sni: plan.sni,
      first: first.length,
      second: second.length,
      at: Date.now(),
    });
  }

  /** Hedefe giden soketi açar: doğrudan (DoH ile) veya yukarı akış üzerinden. */
  async openUpstream(host, port) {
    const { upstream } = this.config;

    if (upstream.enabled) {
      const connectOpts = {
        targetHost: host,
        targetPort: port,
        proxyHost: upstream.host,
        proxyPort: Number(upstream.port) || (upstream.type === 'socks5' ? 1080 : 8080),
        username: upstream.username,
        password: upstream.password,
        timeout: CONNECT_TIMEOUT_MS,
      };
      const socket =
        upstream.type === 'socks5' ? await connectSocks5(connectOpts) : await connectHttpProxy(connectOpts);
      return socket;
    }

    const addresses = await this.doh.resolve(host);
    let lastError = null;
    for (const address of addresses) {
      try {
        return await new Promise((resolve, reject) => {
          const socket = net.connect({ host: address, port });
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('zaman aşımı'));
          }, CONNECT_TIMEOUT_MS);
          socket.once('connect', () => {
            clearTimeout(timer);
            socket.removeAllListeners('error');
            resolve(socket);
          });
          socket.once('error', (err) => {
            clearTimeout(timer);
            socket.destroy();
            reject(err);
          });
        });
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('çözümlenemedi');
  }
}

module.exports = { DesyncProxy, parseAuthority, normalizeHost, connectSocks5, connectHttpProxy };
