// Bridge for the small update window (src/renderer/updater.html).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updater', {
  onState: (fn) => ipcRenderer.on('updater-state', (_e, state) => fn(state)),
  choose: (choice) => ipcRenderer.send('updater-choice', choice),
});
