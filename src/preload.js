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
  play: () => ipcRenderer.invoke('play'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  minimize: () => ipcRenderer.send('window', 'minimize'),
  close: () => ipcRenderer.send('window', 'close'),
  onStatus: (fn) => ipcRenderer.on('status', (_e, data) => fn(data)),
  onGameStarted: (fn) => ipcRenderer.on('game-started', () => fn()),
  onGameClosed: (fn) => ipcRenderer.on('game-closed', (_e, error) => fn(error)),
});
