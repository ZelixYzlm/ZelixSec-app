'use strict';

/**
 * ZelixSec - Teşhis (diagnostics)
 * -------------------------------
 * Aynı hedefe üç yol dener ve sonucu karşılaştırır:
 *   1) DoH ile DNS çözümü  -> DNS zehirlemesi var mı?
 *   2) Doğrudan TLS        -> DPI bloğu gerçekten var mı?
 *   3) Proxy üzerinden TLS -> ZelixSec bloğu aşabiliyor mu?
 * Bu, "bağlandım ama çalışmıyor" durumunu tahminle değil ölçümle ayırır.
 */

const net = require('node:net');
const tls = require('node:tls');
const { DohResolver } = require('./doh');

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} zaman aşımı`)), ms)),
  ]);
}

function tcpConnect(host, port, timeoutMs = 5000) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const started = process.hrtime.bigint();
      const socket = net.connect({ host, port });
      socket.once('connect', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        socket.destroy();
        resolve(ms);
      });
      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
    }),
    timeoutMs + 500,
    'TCP',
  );
}

function tlsHandshake(host, port, target, timeoutMs = 6000) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const started = process.hrtime.bigint();
      const socket = net.connect({ host, port });
      socket.once('error', reject);
      socket.once('connect', () => {
        const inner = tls.connect({ socket, servername: target, ALPNProtocols: ['http/1.1'] });
        inner.once('secureConnect', () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          const protocol = inner.getProtocol();
          inner.destroy();
          socket.destroy();
          resolve({ ms, protocol });
        });
        inner.once('error', (err) => {
          inner.destroy();
          socket.destroy();
          reject(err);
        });
      });
    }),
    timeoutMs,
    'TLS',
  );
}

/** Yerel proxy üzerinden CONNECT + TLS el sıkışması. */
function tlsThroughProxy(proxyPort, target, timeoutMs = 8000) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const started = process.hrtime.bigint();
      const socket = net.connect({ host: '127.0.0.1', port: proxyPort });
      let buffer = Buffer.alloc(0);
      let phase = 'connect';

      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(`CONNECT ${target}:443 HTTP/1.1\r\nHost: ${target}:443\r\n\r\n`);
      });
      socket.on('data', (chunk) => {
        if (phase !== 'connect') return;
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString('latin1');
        if (!/^HTTP\/1\.1 200/.test(head)) {
          socket.destroy();
          reject(new Error(`proxy CONNECT reddetti: ${head.split('\r\n')[0]}`));
          return;
        }
        const rest = buffer.subarray(end + 4);
        if (rest.length) socket.unshift(rest);
        phase = 'tls';
        socket.removeAllListeners('data');
        const inner = tls.connect({ socket, servername: target, ALPNProtocols: ['http/1.1'] });
        inner.once('secureConnect', () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          const protocol = inner.getProtocol();
          inner.destroy();
          socket.destroy();
          resolve({ ms, protocol });
        });
        inner.once('error', (err) => {
          inner.destroy();
          socket.destroy();
          reject(err);
        });
      });
    }),
    timeoutMs,
    'Proxy TLS',
  );
}

/**
 * @param {object} opts
 * @param {string} opts.host       test edilecek alan adı (discord.com gibi)
 * @param {number} opts.proxyPort  çalışan yerel proxy portu
 * @param {object} opts.doh       { enabled, provider, allowSystemFallback }
 */
async function runDiagnostics(opts) {
  const { host, proxyPort, doh = {} } = opts;
  const resolver = new DohResolver(doh);
  const report = {
    host,
    at: Date.now(),
    dns: { ok: false, ips: [], ms: 0, error: null },
    direct: { ok: false, ms: 0, ip: null, protocol: null, error: null },
    secured: { ok: false, ms: 0, protocol: null, error: null },
    verdict: 'unknown',
    notes: [],
  };

  const dnsStarted = Date.now();
  try {
    const ips = await resolver.resolve(host);
    report.dns = { ok: ips.length > 0, ips, ms: Date.now() - dnsStarted, error: null };
  } catch (err) {
    report.dns = { ok: false, ips: [], ms: Date.now() - dnsStarted, error: err.message };
  }

  if (!report.dns.ok) {
    report.verdict = 'dns-failed';
    report.notes.push('Alan adı çözümlenemedi. DoH sağlayıcısını değiştirmeyi deneyin.');
    return report;
  }

  const ip = report.dns.ips.find((value) => net.isIP(value) === 4) || report.dns.ips[0];

  try {
    report.direct.ms = Number((await tcpConnect(ip, 443)).toFixed(1));
  } catch (err) {
    report.direct.error = `TCP: ${err.message}`;
  }

  if (!report.direct.error) {
    try {
      const handshake = await tlsHandshake(ip, 443, host);
      report.direct.ok = true;
      report.direct.ms = Number(handshake.ms.toFixed(1));
      report.direct.protocol = handshake.protocol;
      report.direct.ip = ip;
    } catch (err) {
      report.direct.error = err.message;
      report.direct.ip = ip;
    }
  }

  try {
    const secured = await tlsThroughProxy(proxyPort, host);
    report.secured.ok = true;
    report.secured.ms = Number(secured.ms.toFixed(1));
    report.secured.protocol = secured.protocol;
  } catch (err) {
    report.secured.error = err.message;
  }

  if (report.direct.ok && report.secured.ok) {
    report.verdict = 'open';
    report.notes.push('Ağda bu alan adına DPI bloğu görünmüyor; ZelixSec yine de parçalama uyguluyor.');
  } else if (!report.direct.ok && report.secured.ok) {
    report.verdict = 'bypassed';
    report.notes.push('Doğrudan bağlantı engellendi, ZelixSec bağlantıyı kurdu. Blok aşılıyor.');
  } else if (report.direct.ok && !report.secured.ok) {
    report.verdict = 'proxy-error';
    report.notes.push('Doğrudan bağlantı çalışıyor ama proxy başarısız. Parçalama modunu veya portu değiştirin.');
  } else {
    report.verdict = 'blocked-hard';
    report.notes.push(
      'İki yol da başarısız: IP seviyesinde blok olabilir. Yukarı akış (SOCKS5/WARP) gerekir.',
    );
  }

  return report;
}

module.exports = { runDiagnostics, tlsHandshake, tlsThroughProxy, tcpConnect };
