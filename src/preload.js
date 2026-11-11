// Safe bridge between the UI (renderer) and the launcher (main process).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  init: () => ipcRenderer.invoke('init'),
  pack: () => ipcRenderer.invoke('pack'),
  betaCheckKey: (key) => ipcRenderer.invoke('beta-check-key', key),
  betaSet: (beta) => ipcRenderer.invoke('beta-set', beta),
  checkUpdatesNow: () => ipcRenderer.invoke('check-updates-now'),
  login: () => ipcRenderer.invoke('login'),
  logout: () => ipcRenderer.invoke('logout'),
  play: (options) => ipcRenderer.invoke('play', options),
  install: () => ipcRenderer.invoke('install'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  minimize: () => ipcRenderer.send('window', 'minimize'),
  toggleMaximize: () => ipcRenderer.send('window', 'maximize'),
  onMaximized: (fn) => ipcRenderer.on('maximized', (_e, on) => fn(on)),
  close: () => ipcRenderer.send('window', 'close'),
  onStatus: (fn) => ipcRenderer.on('status', (_e, data) => fn(data)),
  onGameStarted: (fn) => ipcRenderer.on('game-started', () => fn()),
  onGameClosed: (fn) => ipcRenderer.on('game-closed', (_e, error) => fn(error)),
});
