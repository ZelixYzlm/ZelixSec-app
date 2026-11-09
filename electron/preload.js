'use strict';

/**
 * ZelixSec - preload köprüsü
 * Arayüz yalnızca bu beyaz listedeki çağrıları yapabilir (nodeIntegration kapalı).
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('zelix', {
  getState: () => ipcRenderer.invoke('state:get'),
  start: () => ipcRenderer.invoke('engine:start'),
  stop: () => ipcRenderer.invoke('engine:stop'),
  toggle: (running) => ipcRenderer.invoke('engine:toggle', running),
  patchSettings: (partial) => ipcRenderer.invoke('settings:patch', partial),
  setProfile: (profileId) => ipcRenderer.invoke('profile:set', profileId),
  setSystemProxy: (enabled) => ipcRenderer.invoke('system-proxy:set', enabled),
  diagnose: (host) => ipcRenderer.invoke('diagnostics:run', host),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  clearAdBlock: () => ipcRenderer.invoke('adblock:clear'),
  testAdBlock: () => ipcRenderer.invoke('adblock:test'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  exportLogs: () => ipcRenderer.invoke('logs:export'),
  flushDns: () => ipcRenderer.invoke('dns:flush'),
  copy: (text) => ipcRenderer.invoke('clipboard:copy', text),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  quit: () => ipcRenderer.invoke('app:quit'),
  hide: () => ipcRenderer.invoke('window:hide'),
  onLog: subscribe('engine:log'),
  onStatus: subscribe('engine:status'),
  onSplit: subscribe('engine:split'),
  onSettings: subscribe('settings:changed'),
  onUpdateStatus: subscribe('update:status'),
  onUpdateProgress: subscribe('update:progress'),
});
