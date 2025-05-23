const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    startBackend: () => ipcRenderer.invoke('start-backend'),
    stopBackend: () => ipcRenderer.invoke('stop-backend'),
    fetchStatus: () => ipcRenderer.invoke('fetch-status'),
    fetchCheatSheet: () => ipcRenderer.invoke('fetch-cheat-sheet'),
    onBackendStatus: (callback) => ipcRenderer.on('backend-status', (_event, value) => callback(value)),
    onPythonLog: (callback) => ipcRenderer.on('python-log', (_event, value) => callback(value)),
    onNewTranscript: (callback) => ipcRenderer.on('new_transcript', (_event, value) => callback(value)), // From backend via socket
    onUpdateCheatSheet: (callback) => ipcRenderer.on('update_cheat_sheet', (_event, value) => callback(value)), // From backend via socket
});