'use strict';

/**
 * ZelixSec - Ayar deposu
 * Ayarlar kullanıcı veri klasöründe JSON olarak tutulur (şifre hariç hiçbir
 * şey şifrelenmez; yukarı akış şifresi yalnızca yerelde saklanır).
 */

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_UPDATE_URL } = require('./updates');

const PROFILES = [
  {
    id: 'discord',
    name: 'Discord',
    emoji: '💬',
    hosts: ['discord.com', 'discordapp.com', 'discordapp.net', 'discord.gg', 'discord.media', 'discordstatus.com'],
  },
  {
    id: 'roblox',
    name: 'Roblox',
    emoji: '🧱',
    hosts: ['roblox.com', 'rbxcdn.com', 'rbx.com', 'robloxlabs.com', 'roblox.cn', 'roblox.qq.com'],
  },
  {
    id: 'social',
    name: 'Sosyal + Yayın',
    emoji: '📡',
    hosts: [
      'twitter.com',
      'x.com',
      'instagram.com',
      'facebook.com',
      'youtube.com',
      'twitch.tv',
      'tiktok.com',
      'wikipedia.org',
      'pastebin.com',
    ],
  },
  {
    id: 'all',
    name: 'Tüm Trafik',
    emoji: '🌐',
    hosts: [],
  },
];

const DEFAULTS = {
  activeProfile: 'discord',
  customHosts: [],
  engine: {
    port: 7717,
    mode: 'split2',
    splitPosition: 1,
    splitDelayMs: 0,
  },
  doh: {
    enabled: true,
    provider: 'cloudflare',
    allowSystemFallback: true,
  },
  upstream: {
    enabled: false,
    type: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    username: '',
    password: '',
  },
  systemProxy: {
    enabled: false,
    lastApplied: null,
  },
  adblock: {
    enabled: true,
    customBlocked: [],
  },
  appearance: {
    theme: 'neon',
    opacity: 78,
    aurora: true,
  },
  update: {
    manifestUrl: DEFAULT_UPDATE_URL,
    autoCheck: true,
    lastCheck: null,
  },
  app: {
    autoStart: false,
    minimizeToTray: true,
    autoConnect: true,
    autoSystemProxy: true,
    language: 'tr',
  },
  diagnosticsTarget: 'discord.com',
};

function deepMerge(base, patch) {
  if (Array.isArray(base)) return Array.isArray(patch) ? patch.slice() : base.slice();
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

class Store {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'zelixsec-settings.json');
    this.data = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return deepMerge(DEFAULTS, JSON.parse(raw));
    } catch {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  get() {
    return this.data;
  }

  patch(partial) {
    this.data = deepMerge(this.data, partial || {});
    this.save();
    return this.data;
  }

  reset() {
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    this.save();
    return this.data;
  }

  /**
   * Profil + özel host listesinden motor için allowlist üretir.
   * 'all' profili boş liste döner = her hostta bölme uygulanır.
   */
  allowlistFor(profileId, customHosts = []) {
    const extra = Array.isArray(customHosts)
      ? customHosts
      : String(customHosts || '').split(/[\s,;]+/);
    const cleaned = extra.map((h) => String(h).trim().toLowerCase()).filter(Boolean);

    if (profileId === 'all') return [];
    if (profileId === 'custom') return Array.from(new Set(cleaned));

    const profile = PROFILES.find((p) => p.id === profileId) || PROFILES[0];
    return Array.from(new Set([...profile.hosts, ...cleaned]));
  }
}

module.exports = { Store, PROFILES, DEFAULTS, deepMerge };
