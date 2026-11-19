// Preload for the main-process demo. Sandboxed, which is Electron's default:
// it cannot load lua-native, so it only forwards calls over IPC. CommonJS
// because a sandboxed preload cannot be an ES module.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lua', {
  run: (source, mode) => ipcRenderer.invoke('lua:run', source, mode),
  stop: () => ipcRenderer.invoke('lua:stop'),
  reset: () => ipcRenderer.invoke('lua:reset'),
  onOutput: (listener) => {
    ipcRenderer.on('lua:output', (_event, text) => listener(text));
  },
  openCanvasDemo: () => ipcRenderer.invoke('demo:open-canvas'),
  openRpgDemo: () => ipcRenderer.invoke('demo:open-rpg'),
});
