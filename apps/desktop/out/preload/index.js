"use strict";
const electron = require("electron");
function createEventListener(channel, callback) {
  const handler = (_event, data) => callback(data);
  electron.ipcRenderer.on(channel, handler);
  return () => {
    electron.ipcRenderer.removeListener(channel, handler);
  };
}
const desktopAPI = {
  // Server control
  server: {
    getStatus: () => electron.ipcRenderer.invoke("server:status"),
    start: () => electron.ipcRenderer.invoke("server:start"),
    stop: () => electron.ipcRenderer.invoke("server:stop"),
    restart: () => electron.ipcRenderer.invoke("server:restart"),
    onStatusChanged: (callback) => createEventListener("server:status-changed", callback),
    onError: (callback) => createEventListener("server:error", callback)
  },
  // Application info
  app: {
    getVersion: () => electron.ipcRenderer.invoke("app:version"),
    getPlatform: () => electron.ipcRenderer.invoke("app:platform")
  },
  // Update control
  update: {
    check: () => electron.ipcRenderer.invoke("update:check"),
    download: () => electron.ipcRenderer.invoke("update:download"),
    install: () => electron.ipcRenderer.invoke("update:install"),
    getState: () => electron.ipcRenderer.invoke("update:state"),
    onStateChanged: (callback) => createEventListener("update:state-changed", callback)
  },
  // Window control
  window: {
    minimize: () => electron.ipcRenderer.invoke("window:minimize"),
    maximize: () => electron.ipcRenderer.invoke("window:maximize"),
    close: () => electron.ipcRenderer.invoke("window:close")
  },
  // External links
  shell: {
    openExternal: (url) => electron.ipcRenderer.invoke("shell:openExternal", url)
  },
  // Flag to indicate running in Electron
  isElectron: true
};
electron.contextBridge.exposeInMainWorld("desktopAPI", desktopAPI);
electron.contextBridge.exposeInMainWorld("isElectron", true);
console.log("[Preload] Desktop API exposed to renderer");
