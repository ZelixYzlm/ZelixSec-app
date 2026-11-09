'use strict';

/**
 * ZelixSec - Sistem vekili yönetimi
 * --------------------------------
 * Tek tuşla çalışsın diye trafiğin tamamını yerel motora yönlendirir.
 * Her platformda önce mevcut ayarlar yedeklenir, kapatınca geri yazılır.
 * Yönetici hakkı GEREKMEZ (HKCU / kullanıcı ağ servisleri / gsettings).
 */

const { execFile } = require('node:child_process');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(' ')} -> ${(stderr || err.message).trim()}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

async function windowsRead() {
  const out = await run('reg', ['query', REG_KEY]);
  const value = (name) => {
    const line = out.split(/\r?\n/).find((l) => l.trim().startsWith(name));
    if (!line) return null;
    const parts = line.trim().split(/\s{2,}/);
    return parts.length >= 3 ? parts.slice(2).join('  ') : null;
  };
  return {
    enabled: String(value('ProxyEnable') || '0x0').includes('0x1'),
    server: value('ProxyServer'),
    override: value('ProxyOverride'),
  };
}

/** Windows'a ayar değişikliğini anında duyurur (tarayıcılar beklemeden görsün). */
async function windowsNotify() {
  const script = `
$sig = '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);';
$t = Add-Type -MemberDefinition $sig -Name W -Namespace Z -PassThru;
[void]$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0);
[void]$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0);
`.replace(/\n/g, ' ');
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 15000);
}

async function setWindows(enabled, hostPort) {
  if (enabled) {
    await run('reg', ['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
    await run('reg', ['add', REG_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', hostPort, '/f']);
    await run('reg', ['add', REG_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', '<local>', '/f']);
  } else {
    await run('reg', ['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
  }
  await windowsNotify().catch(() => {});
}

async function macServices() {
  const out = await run('networksetup', ['-listallnetworkservices']);
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('An asterisk') && !l.startsWith('*'));
}

async function setMac(enabled, host, port) {
  const services = await macServices();
  for (const service of services) {
    if (enabled) {
      await run('networksetup', ['-setwebproxy', service, host, String(port)]).catch(() => {});
      await run('networksetup', ['-setsecurewebproxy', service, host, String(port)]).catch(() => {});
    } else {
      await run('networksetup', ['-setwebproxystate', service, 'off']).catch(() => {});
      await run('networksetup', ['-setsecurewebproxystate', service, 'off']).catch(() => {});
    }
  }
}

async function setLinux(enabled, host, port) {
  const gsettings = (args) => run('gsettings', args).catch(() => null);
  if (enabled) {
    await gsettings(['set', 'org.gnome.system.proxy', 'mode', 'manual']);
    for (const schema of ['org.gnome.system.proxy.http', 'org.gnome.system.proxy.https']) {
      await gsettings(['set', schema, 'host', host]);
      await gsettings(['set', schema, 'port', String(port)]);
    }
    await gsettings(['set', 'org.gnome.system.proxy', 'ignore-hosts', "['localhost','127.0.0.0/8','::1']"]);
  } else {
    await gsettings(['set', 'org.gnome.system.proxy', 'mode', 'none']);
  }
}

async function flushDns() {
  try {
    if (IS_WIN) await run('ipconfig', ['/flushdns']);
    else if (IS_MAC) await run('dscacheutil', ['-flushcache']);
    else await run('resolvectl', ['flush-caches']);
    return true;
  } catch {
    return false;
  }
}

class SystemProxy {
  constructor() {
    this.backup = null;
    this.applied = false;
  }

  async enable(hostPort) {
    const [host, port] = String(hostPort).split(':');
    if (!this.backup) {
      if (IS_WIN) this.backup = await windowsRead().catch(() => null);
      else this.backup = { fileOnly: true };
    }
    if (IS_WIN) await setWindows(true, hostPort);
    else if (IS_MAC) await setMac(true, host, port);
    else await setLinux(true, host, port);
    this.applied = true;
    return { applied: true, hostPort, platform: process.platform };
  }

  async disable() {
    if (IS_WIN) await setWindows(false);
    else if (IS_MAC) await setMac(false);
    else await setLinux(false);
    this.applied = false;
    return { applied: false, platform: process.platform };
  }

  status() {
    return { applied: this.applied, platform: process.platform, backup: Boolean(this.backup) };
  }
}

module.exports = { SystemProxy, flushDns, windowsRead };
