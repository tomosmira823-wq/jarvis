const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  testKey: (k) => ipcRenderer.invoke('test-key', k),
  send: (text) => ipcRenderer.invoke('send-message', text),
  stop: () => ipcRenderer.invoke('stop'),
  newChat: () => ipcRenderer.invoke('new-chat'),
  approve: (id, ok) => ipcRenderer.invoke('approval', { id, ok }),
  listen: () => ipcRenderer.invoke('listen'),
  getMemory: () => ipcRenderer.invoke('get-memory'),
  setMemory: (m) => ipcRenderer.invoke('set-memory', m),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  onEvent: (cb) => ipcRenderer.on('agent-event', (_e, d) => cb(d)),
  onUpdate: (cb) => ipcRenderer.on('update-status', (_e, d) => cb(d)),
  onFocusInput: (cb) => ipcRenderer.on('focus-input', () => cb()),
});
