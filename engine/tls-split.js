'use strict';

/**
 * ZelixSec - TLS/HTTP parçalama çekirdeği
 * ---------------------------------------
 * Amaç: DPI (Deep Packet Inspection) cihazları SNI alanını tek pakette
 * gördüğünde bağlantıyı bloklar / sıfırlar. ClientHello'yu iki ayrı TCP
 * segmentine bölerek SNI'ı iki pakete dağıtırız ve DPI'ın imzası bozulur.
 *
 * Bu dosya ağ G/Ç yapmaz; sadece "nereden bölünecek" kararını verir.
 * Böylece saf fonksiyonlar olarak test edilebilir.
 */

const RECORD_HANDSHAKE = 0x16;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const EXT_SERVER_NAME = 0x0000;

/** Bir tamponun TLS ClientHello kaydı ile başlayıp başlamadığını söyler. */
function looksLikeClientHello(buf) {
  if (!buf || buf.length < 6) return false;
  if (buf[0] !== RECORD_HANDSHAKE) return false;
  if (buf[1] !== 0x03) return false; // TLS 1.x
  return buf[5] === HANDSHAKE_CLIENT_HELLO;
}

/** TLS kayıt başlığındaki uzunluğa göre kaydın tamamının elimizde olup olmadığı. */
function clientHelloComplete(buf) {
  if (!looksLikeClientHello(buf) || buf.length < 5) return false;
  const recordLen = buf.readUInt16BE(3);
  return buf.length >= 5 + recordLen;
}

/**
 * ClientHello içindeki SNI (server_name) alanını bulur.
 * @returns {{sni: string, offset: number, length: number}|null}
 *          offset: tampon içindeki hostname'in ilk baytının mutlak indeksi
 */
function readServerName(buf) {
  if (!looksLikeClientHello(buf)) return null;

  const recordLen = buf.readUInt16BE(3);
  const recordEnd = Math.min(buf.length, 5 + recordLen);

  let p = 5; // TLS kayıt başlığı
  p += 4; // handshake type (1) + length (3)
  p += 2 + 32; // client_version + random
  if (p + 1 > recordEnd) return null;

  const sessionIdLen = buf[p];
  p += 1 + sessionIdLen;
  if (p + 2 > recordEnd) return null;

  const cipherLen = buf.readUInt16BE(p);
  p += 2 + cipherLen;
  if (p + 1 > recordEnd) return null;

  const compLen = buf[p];
  p += 1 + compLen;
  if (p + 2 > recordEnd) return null;

  const extTotal = buf.readUInt16BE(p);
  p += 2;
  const extEnd = Math.min(recordEnd, p + extTotal);

  while (p + 4 <= extEnd) {
    const type = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    const dataStart = p + 4;
    if (dataStart + len > extEnd) break;

    if (type === EXT_SERVER_NAME) {
      // server_name_list: list_len(2) | type(1) | name_len(2) | name
      const nameStart = dataStart + 5;
      if (nameStart > dataStart + len) break;
      const nameLen = buf.readUInt16BE(dataStart + 3);
      if (nameStart + nameLen > buf.length) break;
      const sni = buf.toString('latin1', nameStart, nameStart + nameLen);
      return { sni, offset: nameStart, length: nameLen };
    }
    p = dataStart + len;
  }
  return null;
}

/**
 * Bölme modları:
 *  - 'off'          : hiç bölme (referans / yönlendirici modu)
 *  - 'split2'       : SNI'ın ilk baytı 1. segmentte, geri kalanı 2. segmentte
 *                     (zapret/GoodbyeDPI "split2" davranışı)
 *  - 'split-sni'    : hostname'in TAMAMI 1. segmentte, sonrası 2. segmentte
 *  - 'split-record' : TLS kayıt başlığından hemen sonra (5. bayt) böl
 *  - 'split-pos'    : kullanıcının verdiği sabit ofsetten böl
 *  - 'split-middle' : paketi ortadan ikiye böl (agresif, HTTP için de çalışır)
 */
const MODES = ['off', 'split2', 'split-sni', 'split-record', 'split-pos', 'split-middle'];

/**
 * Gelen tamponu bölme planına çevirir.
 * @returns {{parts: Buffer[], offset: number, sni: string|null, mode: string}}
 */
function planSplit(buf, mode = 'split2', splitPosition = 1) {
  const safeMode = MODES.includes(mode) ? mode : 'split2';
  const total = buf.length;

  if (total < 2 || safeMode === 'off') {
    return { parts: [buf], offset: 0, sni: null, mode: 'off' };
  }

  const info = readServerName(buf);
  const sni = info ? info.sni : null;
  let offset = 0;

  if (safeMode === 'split2') {
    offset = info ? info.offset + 1 : Math.min(5, total - 1);
  } else if (safeMode === 'split-sni') {
    offset = info ? info.offset + info.length : Math.min(5, total - 1);
  } else if (safeMode === 'split-record') {
    offset = Math.min(5, total - 1);
  } else if (safeMode === 'split-pos') {
    offset = Math.min(Math.max(1, splitPosition | 0), total - 1);
  } else if (safeMode === 'split-middle') {
    offset = Math.max(1, Math.floor(total / 2));
  }

  if (offset <= 0) offset = 1;
  if (offset >= total) offset = total - 1;

  return {
    parts: [buf.subarray(0, offset), buf.subarray(offset)],
    offset,
    sni,
    mode: safeMode,
  };
}

/**
 * Düz HTTP isteği (proxy üzerinden gelen mutlak URL'li istek) için bölme.
 * İstek satırı + başlıkların ortasından bölmek DPI'ın host imzasını bozar.
 */
function planHttpSplit(headBuffer) {
  const text = headBuffer.toString('latin1');
  const hostIdx = text.toLowerCase().indexOf('\r\nhost:');
  if (hostIdx >= 0) {
    const offset = Math.min(headBuffer.length - 1, hostIdx + 1);
    if (offset > 0) {
      return { parts: [headBuffer.subarray(0, offset), headBuffer.subarray(offset)], offset };
    }
  }
  const mid = Math.max(1, Math.floor(headBuffer.length / 2));
  return { parts: [headBuffer.subarray(0, mid), headBuffer.subarray(mid)], offset: mid };
}

module.exports = {
  MODES,
  looksLikeClientHello,
  clientHelloComplete,
  readServerName,
  planSplit,
  planHttpSplit,
};
