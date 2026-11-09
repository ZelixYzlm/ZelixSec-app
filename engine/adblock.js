'use strict';

/**
 * ZelixSec - Reklam ve izleyici engelleyici
 * ----------------------------------------
 * Sistem vekili açıkken uygulamaların (tarayıcı, oyun istemcisi) reklam
 * ağlarına açtığı CONNECT/HTTP isteklerini yerelde reddeder. Liste
 * tamamıyla yereldir: dış sunucu sorgusu yapılmaz.
 *
 * Eşleşme "sonek" temellidir: "doubleclick.net" kuralı geçerlidir ve
 * "pagead2.doubleclick.net" gibi alt alan adlarını da kapsar. Ayrıca
 * "ads.x.com", "adserver.x.com", "adservice.x.com" biçimli öneki de
 * engellenir.
 */

const BUILTIN_BLOCKED = [
  /* Google reklam ailesi */
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'analytics.google.com',
  'imasdk.googleapis.com',
  'admob.com',
  'app-measurement.com',

  /* Sosyal medya reklam/izleyici uçları */
  'connect.facebook.net',
  'an.facebook.com',
  'ads.tiktok.com',
  'analytics.tiktok.com',
  'static.ads-twitter.com',
  'ads.pinterest.com',
  'ads.snapchat.com',

  /* RTB / reklam borsaları (SSP-DSP) */
  'adnxs.com',
  'adnxs-simple.com',
  'adsrvr.org',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'indexww.com',
  'casalemedia.com',
  'adform.net',
  'smartadserver.com',
  'bidswitch.net',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'mgid.com',
  'teads.tv',
  'yieldmo.com',
  'media.net',
  '33across.com',
  'sharethrough.com',
  'sonobi.com',
  'bidr.io',
  'amazon-adsystem.com',
  '2mdn.net',
  'adsafeprotected.com',
  'moatads.com',
  'doubleverify.com',
  'gidgted.com',

  /* Pop/push/başdöndüren reklam ağları */
  'propellerads.com',
  'popads.net',
  'popcash.net',
  'adcash.com',
  'clicksor.com',
  'exoclick.com',
  'revcontent.com',
  'zedo.com',
  'zeropark.com',
  'adroll.com',
  'clickadu.com',

  /* Rusça/CIS reklam ve sayaçlar */
  'an.yandex.ru',
  'adfox.ru',
  'mc.yandex.ru',
  'top-fwz1.mail.ru',
  'st.top100.ru',

  /* Türkiye yerel reklam ağları */
  'mediaad.org',
  'admatic.com.tr',

  /* Mobil reklam SDK'ları */
  'applovin.com',
  'adcolony.com',
  'unityads.unity3d.com',
  'inmobi.com',
  'mopub.com',
  'chartboost.com',
  'vungle.com',
  'fyber.com',
  'heyzap.com',
  'tapjoy.com',
  'ironsrc.com',

  /* İzlemek/attribution/'analitik reklam' zincirleri */
  'appsflyer.com',
  'adjust.com',
  'branch.io',
  'onesignal.com',
  'mixpanel.com',
  'amplitude.com',
  'segment.io',
  'segment.com',
  'hotjar.com',
  'fullstory.com',
  'statcounter.com',
  'histats.com',
  'addthis.com',
  'sharethis.com',
  'quantserve.com',
  'scorecardresearch.com',
];

/** Öneki engellenen evrensel kalıplar (alt alan adına göre eşleşir). */
const PREFIX_RULES = ['ads.', 'adserver.', 'adservice.'];

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function normalizeDomain(host) {
  let value = String(host || '').toLowerCase().trim();
  // Yapıştırılan tam URL'leri de kabul et: https://reklam.ornek.com/x -> reklam.ornek.com
  if (/^https?:\/\//.test(value)) {
    try {
      value = new URL(value).hostname || '';
    } catch {
      value = value.replace(/^https?:\/\//, '');
    }
  }
  value = value.replace(/\/.*$/, '').replace(/^\[|\]$/g, '').replace(/\.$/, '');
  // Yol/oppinsiz boşluk temizliği
  return value.trim();
}

function cleanRules(list) {
  const out = new Set();
  for (const item of list || []) {
    let value = normalizeDomain(item);
    if (!value) continue;
    value = value.replace(/^\*\./, ''); // *.ornek.com -> ornek.com
    if (value && value.includes('.')) out.add(value);
  }
  return out;
}

class AdBlocker {
  /**
   * @param {object} opts
   * @param {boolean} opts.enabled        engelleyici açık mı
   * @param {string[]} [opts.customBlocked] kullanıcı eklediği alan adları
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.custom = Array.isArray(opts.customBlocked) ? opts.customBlocked.slice() : [];
    this.rules = new Set();
    this.customRules = new Set();
    this._rebuild();
  }

  configure(next = {}) {
    if (typeof next.enabled === 'boolean') this.enabled = next.enabled;
    if (Array.isArray(next.customBlocked)) this.custom = next.customBlocked.slice();
    this._rebuild();
  }

  _rebuild() {
    this.rules = cleanRules(BUILTIN_BLOCKED);
    this.customRules = cleanRules(this.custom);
  }

  counts() {
    return { builtin: this.rules.size, custom: this.customRules.size };
  }

  /**
   * Host reklam/izleyici mi?
   * @param {string} host ham hostname ("ads.ornek.com", IP, "ornek.com" ...)
   */
  blocks(host) {
    if (!this.enabled) return false;
    const h = normalizeDomain(host).replace(/^www\./, '');
    if (!h || h.includes('localhost') || IPV4_RE.test(h) || /^:+/.test(h)) return false;

    for (const prefix of PREFIX_RULES) {
      if (h === prefix.slice(0, -1) || h.startsWith(prefix) || h.includes(`.${prefix}`)) return true;
    }

    for (const rules of [this.customRules, this.rules]) {
      for (const rule of rules) {
        if (h === rule || h.endsWith(`.${rule}`)) return true;
      }
    }
    return false;
  }
}

module.exports = { AdBlocker, BUILTIN_BLOCKED, PREFIX_RULES, normalizeDomain };
