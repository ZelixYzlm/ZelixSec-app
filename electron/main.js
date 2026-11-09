'use strict';

/**
 * ZelixSec - Elektron ana süreç
 * ============================
 * Motor (engine/) burada yönetilir; arayüz yalnızca IPC ile konuşur.
 * Uygulama kapansa bile sistem vekili açık kalmasın diye çıkışta her şey
 * geri alınır.
 */

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { DesyncProxy } = require('../engine/proxy');
const { runDiagnostics, tlsThroughProxy } = require('../engine/diagnostics');
const { Store, PROFILES } = require('./store');
const { SystemProxy, flushDns } = require('./system-proxy');
const { UpdateService } = require('./updates');

const MAX_LOGS = 600;

let win = null;
let tray = null;
let store = null;
let proxy = null;
let systemProxy = null;
let updater = null;
let quitting = false;
let logs = [];
let lastStatus = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/* ------------------------------------------------------------------ yardımcı */

function pushLog(level, message, extra = {}) {
  const entry = { level, message, at: Date.now(), ...extra };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
  broadcast('engine:log', entry);
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function currentAllowlist() {
  const data = store.get();
  return store.allowlistFor(data.activeProfile, data.customHosts);
}

function buildEngineConfig() {
  const data = store.get();
  return {
    port: data.engine.port,
    mode: data.engine.mode,
    splitPosition: data.engine.splitPosition,
    splitDelayMs: data.engine.splitDelayMs,
    allowlist: currentAllowlist(),
    adblock: { ...data.adblock },
    doh: { ...data.doh },
    upstream: { ...data.upstream },
  };
}

async function snapshot() {
  const data = store.get();
  return {
    settings: data,
    profiles: PROFILES,
    allowlist: currentAllowlist(),
    status: lastStatus || (proxy ? proxy.getStatus() : null),
    systemProxy: systemProxy ? systemProxy.status() : null,
    platform: process.platform,
    version: app.getVersion(),
    update: updater ? updater.getStatus() : { phase: 'idle' },
    logs,
  };
}

/* -------------------------------------------------------------------- motor */

async function startEngine() {
  if (!proxy) proxy = createProxy();
  proxy.configure(buildEngineConfig());
  const status = await proxy.start();
  lastStatus = status;
  pushLog('info', `Motor hazır → 127.0.0.1:${status.port} (${proxy.config.mode})`);

  const data = store.get();
  if (data.app.autoSystemProxy) {
    try {
      await systemProxy.enable(`127.0.0.1:${status.port}`);
      store.patch({ systemProxy: { enabled: true, lastApplied: new Date().toISOString() } });
      pushLog('info', 'Sistem vekili açıldı (tek tuş modu)');
    } catch (err) {
      pushLog('warn', `Sistem vekili açılamadı: ${err.message}`);
    }
  }

  broadcast('engine:status', proxy.getStatus());
  broadcast('settings:changed', store.get());
  return proxy.getStatus();
}

async function stopEngine() {
  if (systemProxy && systemProxy.applied) {
    try {
      await systemProxy.disable();
      store.patch({ systemProxy: { enabled: false, lastApplied: new Date().toISOString() } });
      pushLog('info', 'Sistem vekili kapatıldı');
    } catch (err) {
      pushLog('warn', `Sistem vekili kapatılamadı: ${err.message}`);
    }
  }
  if (proxy) {
    lastStatus = await proxy.stop();
    broadcast('engine:status', proxy.getStatus());
  }
  broadcast('settings:changed', store.get());
  return lastStatus;
}

function createProxy() {
  const instance = new DesyncProxy(buildEngineConfig());
  instance.on('log', (entry) => pushLog(entry.level || 'info', entry.message));
  instance.on('split', (info) => {
    broadcast('engine:split', info);
    if (info.sni) pushLog('debug', `Bölündü: ${info.sni} @${info.offset} (${info.first}+${info.second} bayt)`);
  });
  return instance;
}

/* ------------------------------------------------------------------- pencere */

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 700,
    show: false,
    backgroundColor: '#070b14',
    title: 'ZelixSec',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (store.get().app.autoConnect) {
      startEngine().catch((err) => pushLog('error', `Otomatik bağlantı başarısız: ${err.message}`));
    }
  });

  win.on('close', (event) => {
    if (!quitting && store.get().app.minimizeToTray) {
      event.preventDefault();
      win.hide();
      return;
    }
    quitting = true;
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* Tepsi menüsü dilleri (kısa set) */
const TRAY_STRINGS = {
  tr: { show: 'Pencereyi Göster', connect: 'Bağlan', disconnect: 'Bağlantıyı Kes', proxyOff: 'Sistem Vekilini Kapat', quit: 'Çıkış' },
  en: { show: 'Show Window', connect: 'Connect', disconnect: 'Disconnect', proxyOff: 'Disable System Proxy', quit: 'Quit' },
  ru: { show: 'Показать окно', connect: 'Подключить', disconnect: 'Отключить', proxyOff: 'Отключить системный прокси', quit: 'Выход' },
  de: { show: 'Fenster zeigen', connect: 'Verbinden', disconnect: 'Verbindung trennen', proxyOff: 'System-Proxy deaktivieren', quit: 'Beenden' },
  fr: { show: 'Afficher la fenêtre', connect: 'Connecter', disconnect: 'Déconnecter', proxyOff: 'Désactiver le proxy système', quit: 'Quitter' },
  es: { show: 'Mostrar ventana', connect: 'Conectar', disconnect: 'Desconectar', proxyOff: 'Desactivar proxy del sistema', quit: 'Salir' },
  it: { show: 'Mostra finestra', connect: 'Connetti', disconnect: 'Disconnetti', proxyOff: 'Disattiva proxy di sistema', quit: 'Esci' },
  pt: { show: 'Mostrar janela', connect: 'Conectar', disconnect: 'Desconectar', proxyOff: 'Desativar proxy do sistema', quit: 'Sair' },
  nl: { show: 'Venster tonen', connect: 'Verbinden', disconnect: 'Verbinding verbreken', proxyOff: 'Systeemproxy uitschakelen', quit: 'Afsluiten' },
  pl: { show: 'Pokaż okno', connect: 'Połącz', disconnect: 'Rozłącz', proxyOff: 'Wyłącz proxy systemowy', quit: 'Zakończ' },
  cs: { show: 'Zobrazit okno', connect: 'Připojit', disconnect: 'Odpojit', proxyOff: 'Vypnout systémový proxy', quit: 'Ukončit' },
  sk: { show: 'Zobraziť okno', connect: 'Pripojiť', disconnect: 'Odpojiť', proxyOff: 'Vypnúť systémový proxy', quit: 'Ukončiť' },
  hu: { show: 'Ablak megjelenítése', connect: 'Kapcsolódás', disconnect: 'Kapcsolat bontása', proxyOff: 'Rendszerproxy kikapcsolása', quit: 'Kilépés' },
  ro: { show: 'Arată fereastra', connect: 'Conectare', disconnect: 'Deconectare', proxyOff: 'Dezactivează proxy sistem', quit: 'Ieșire' },
  bg: { show: 'Покажи прозореца', connect: 'Свързване', disconnect: 'Разкачване', proxyOff: 'Изключване на системно прокси', quit: 'Изход' },
  el: { show: 'Εμφάνιση παραθύρου', connect: 'Σύνδεση', disconnect: 'Αποσύνδεση', proxyOff: 'Απενεργοποίηση proxy συστήματος', quit: 'Έξοδος' },
  uk: { show: 'Показати вікно', connect: 'Підключитися', disconnect: "Відключитися", proxyOff: 'Вимкнути системний проксі', quit: 'Вихід' },
  hr: { show: 'Prikaži prozor', connect: 'Poveži', disconnect: 'Isključi', proxyOff: 'Isključi sustavni proxy', quit: 'Izlaz' },
  sr: { show: 'Prikaži prozor', connect: 'Poveži', disconnect: 'Isključi', proxyOff: 'Isključi sistemski proxy', quit: 'Izlaz' },
  sv: { show: 'Visa fönster', connect: 'Anslut', disconnect: 'Koppla från', proxyOff: 'Inaktivera systemproxy', quit: 'Avsluta' },
  da: { show: 'Vis vindue', connect: 'Forbind', disconnect: 'Afbryd', proxyOff: 'Deaktivér systemproxy', quit: 'Afslut' },
  nb: { show: 'Vis vindu', connect: 'Koble til', disconnect: 'Koble fra', proxyOff: 'Deaktiver systemproxy', quit: 'Avslutt' },
  fi: { show: 'Näytä ikkuna', connect: 'Yhdistä', disconnect: 'Katkaise', proxyOff: 'Poista järjestelmäproxy käytöstä', quit: 'Lopeta' },
};

function iconPath() {
  const candidates = [
    path.join(__dirname, '..', 'assets', 'icon.png'),
    path.join(__dirname, '..', 'assets', 'tray.png'),
  ];
  return candidates.find((file) => fs.existsSync(file)) || undefined;
}

function buildTray() {
  const image = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('ZelixSec');
  const L = TRAY_STRINGS[store?.get()?.app?.language] || TRAY_STRINGS.tr;
  const menu = Menu.buildFromTemplate([
    { label: 'ZelixSec', enabled: false },
    { type: 'separator' },
    { label: L.show, click: () => (win ? win.show() : createWindow()) },
    {
      label: L.connect,
      click: () => startEngine().catch((err) => pushLog('error', err.message)),
    },
    {
      label: L.disconnect,
      click: () => stopEngine().catch((err) => pushLog('error', err.message)),
    },
    { type: 'separator' },
    { label: L.proxyOff, click: () => systemProxy.disable().catch(() => {}) },
    {
      label: L.quit,
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => (win ? win.show() : createWindow()));
}

/* ---------------------------------------------------------------------- IPC */

function registerIpc() {
  ipcMain.handle('state:get', () => snapshot());

  ipcMain.handle('engine:start', async () => {
    try {
      return { ok: true, status: await startEngine() };
    } catch (err) {
      pushLog('error', `Başlatma hatası: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('engine:stop', async () => {
    try {
      return { ok: true, status: await stopEngine() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('engine:toggle', async (_event, running) => {
    try {
      const status = running ? await startEngine() : await stopEngine();
      return { ok: true, status };
    } catch (err) {
      pushLog('error', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('settings:patch', async (_event, partial) => {
    const before = store.get();
    const data = store.patch(partial || {});

    // Motor ayarları canlı uygulanır; port değiştiyse yeniden başlatılır.
    if (proxy && proxy.running) {
      const portChanged = Number(partial?.engine?.port) && Number(partial.engine.port) !== before.engine.port;
      proxy.configure(buildEngineConfig());
      if (portChanged) {
        await stopEngine();
        await startEngine();
      } else if (systemProxy.applied) {
        await systemProxy.enable(`127.0.0.1:${proxy.config.port}`).catch(() => {});
      }
      broadcast('engine:status', proxy.getStatus());
    }

    if (partial?.app && 'autoStart' in partial.app) {
      app.setLoginItemSettings({ openAtLogin: Boolean(partial.app.autoStart) });
    }

    if (partial?.update && 'manifestUrl' in partial.update) {
      if (updater) updater.configure({ manifestUrl: partial.update.manifestUrl });
    }

    broadcast('settings:changed', data);
    return { ok: true, settings: data, allowlist: currentAllowlist() };
  });

  ipcMain.handle('profile:set', async (_event, profileId) => {
    const data = store.patch({ activeProfile: profileId });
    if (proxy) {
      proxy.configure({ allowlist: currentAllowlist() });
      broadcast('engine:status', proxy.getStatus());
    }
    broadcast('settings:changed', data);
    return { ok: true, allowlist: currentAllowlist() };
  });

  ipcMain.handle('system-proxy:set', async (_event, enabled) => {
    try {
      if (enabled) {
        const port = proxy && proxy.running ? proxy.config.port : store.get().engine.port;
        if (!proxy || !proxy.running) await startEngine();
        await systemProxy.enable(`127.0.0.1:${proxy.config.port || port}`);
      } else {
        await systemProxy.disable();
      }
      store.patch({ systemProxy: { enabled, lastApplied: new Date().toISOString() } });
      return { ok: true, systemProxy: systemProxy.status() };
    } catch (err) {
      pushLog('error', `Sistem vekili: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('diagnostics:run', async (_event, host) => {
    try {
      if (!proxy || !proxy.running) await startEngine();
      const port = proxy.config.port;
      const data = store.get();
      pushLog('info', `Teşhis başladı: ${host}`);
      const report = await runDiagnostics({ host, proxyPort: port, doh: data.doh });
      pushLog(
        report.verdict === 'bypassed' ? 'info' : 'warn',
        `Teşhis sonucu: ${report.verdict} (doğrudan ${report.direct.ok ? 'açık' : 'kapalı'}, ZelixSec ${
          report.secured.ok ? 'açık' : 'kapalı'
        })`,
      );
      return { ok: true, report };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('logs:clear', () => {
    logs = [];
    return { ok: true };
  });

  ipcMain.handle('logs:export', async () => {
    const options = {
      title: 'ZelixSec günlüğünü kaydet',
      defaultPath: `zelixsec-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`,
      filters: [{ name: 'Metin', extensions: ['txt', 'log'] }],
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: false };
    const text = logs
      .map((l) => `[${new Date(l.at).toISOString()}] ${l.level.toUpperCase()} ${l.message}`)
      .join('\n');
    fs.writeFileSync(result.filePath, text, 'utf8');
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle('dns:flush', async () => {
    const ok = await flushDns();
    pushLog(ok ? 'info' : 'warn', ok ? 'DNS önbelleği temizlendi' : 'DNS temizliği başarısız');
    return { ok };
  });

  ipcMain.handle('clipboard:copy', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  ipcMain.handle('open:external', (_event, url) => {
    if (/^https?:/.test(String(url))) shell.openExternal(String(url));
    return { ok: true };
  });

  ipcMain.handle('update:check', async () => {
    try {
      const status = await updater.check(true);
      store.patch({ update: { lastCheck: new Date().toISOString() } });
      return { ok: true, status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('update:install', async () => {
    try {
      if (!updater) return { ok: false, error: 'Güncelleme servisi hazır değil' };
      if (updater.phase === 'up-to-date') {
        return { ok: false, error: 'Zaten en güncel sürümdesiniz' };
      }
      if (updater.phase === 'error' && !updater.latest) {
        const fresh = await updater.check(true);
        if (fresh.phase === 'up-to-date') return { ok: false, error: 'Zaten en güncel sürümdesiniz' };
      }
      if (updater.phase !== 'ready') await updater.downloadAndPrepare();
      broadcast('update:status', updater.getStatus());
      pushLog('info', `Güncelleme kurulumu başlatıldı (${updater.latest}); uygulama kapatılacak`);
      const result = await updater.install();
      // Kurulum ~1.6 sn sonra çalışırken uygulama normal yoldan kapanır:
      // before-quit sistemi vekilini geri alır, motor temizlenir.
      setTimeout(() => app.quit(), 1600);
      return { ok: true, status: updater.getStatus(), ...result };
    } catch (err) {
      pushLog('error', `Güncelleme hatası: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('adblock:clear', () => {
    if (proxy) {
      proxy.clearAdBlockStats();
      broadcast('engine:status', proxy.getStatus());
    }
    return { ok: true };
  });

  ipcMain.handle('adblock:test', async () => {
    try {
      if (!proxy) proxy = createProxy();
      proxy.configure(buildEngineConfig());
      if (!proxy.running) {
        lastStatus = await proxy.start();
        broadcast('engine:status', proxy.getStatus());
      }
      let blocked = false;
      let detail = '';
      try {
        await tlsThroughProxy(proxy.config.port, 'doubleclick.net', 6000);
        detail = 'CONNECT onaylandı';
      } catch (err) {
        blocked = true;
        detail = err.message;
      }
      pushLog(
        blocked ? 'info' : 'warn',
        blocked ? `Reklam engelleyici testi: OK (${detail})` : `Reklam engelleyici testi: ENGELLEMEYOR (${detail})`,
      );
      return { ok: true, blocked, detail };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('app:quit', () => {
    quitting = true;
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('window:hide', () => {
    if (win) win.hide();
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ yaşam */

app.on('second-instance', () => {
  if (win) {
    win.show();
    win.focus();
  }
});

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));
  systemProxy = new SystemProxy();
  proxy = createProxy();
  registerIpc();
  createWindow();
  buildTray();

  updater = new UpdateService({
    currentVersion: app.getVersion(),
    tempDir: app.getPath('temp'),
  });
  updater.on('status', (status) => broadcast('update:status', status));
  updater.on('progress', (progress) => broadcast('update:progress', progress));
  updater.on('log', (entry) => pushLog(entry.level || 'info', `[güncelleme] ${entry.message}`));
  updater.configure({ manifestUrl: store.get().update?.manifestUrl });
  if (store.get().update?.autoCheck !== false) {
    setTimeout(() => updater.check().catch(() => {}), 5000);
  }

  if (process.platform === 'win32') app.setAppUserModelId('com.zelixsec.app');
  app.setLoginItemSettings({ openAtLogin: Boolean(store.get().app.autoStart) });

  pushLog('info', `ZelixSec ${app.getVersion()} başladı (${process.platform})`);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || quitting) app.quit();
});

let cleanedUp = false;
app.on('before-quit', async (event) => {
  if (cleanedUp) return;
  event.preventDefault();
  cleanedUp = true;
  quitting = true;
  // Sistem vekili açık kalırsa kullanıcı internete çıkamaz: her zaman geri al.
  if (systemProxy && systemProxy.applied) await systemProxy.disable().catch(() => {});
  if (proxy) await proxy.stop().catch(() => {});
  app.exit(0);
});
