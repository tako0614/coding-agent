/**
 * Preload Script - Secure IPC Bridge
 *
 * Exposes a safe API to the renderer process (Web UI) for:
 * - Server control (start/stop/restart/status)
 * - Application info (version, platform)
 * - Update control (check/download/install)
 * - Window control (minimize/maximize/close)
 *
 * All communication goes through contextBridge for security.
 */

import { contextBridge, ipcRenderer } from 'electron';

// Type definitions for the exposed API
export interface ServerState {
  running: boolean;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  pid?: number;
  port: number;
  startedAt?: string;
  error?: string;
}

export interface UpdaterState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  availableVersion?: string;
  releaseNotes?: string;
  releaseDate?: string;
  downloadProgress?: number;
  error?: string;
}

export interface DesktopAPI {
  // Server control
  server: {
    getStatus: () => Promise<ServerState>;
    start: () => Promise<ServerState>;
    stop: () => Promise<ServerState>;
    restart: () => Promise<ServerState>;
    onStatusChanged: (callback: (state: { status: string }) => void) => () => void;
    onError: (callback: (error: { error: string }) => void) => () => void;
  };

  // Application info
  app: {
    getVersion: () => Promise<string>;
    getPlatform: () => Promise<string>;
  };

  // Update control
  update: {
    check: () => Promise<unknown>;
    download: () => Promise<void>;
    install: () => void;
    getState: () => Promise<UpdaterState>;
    onStateChanged: (callback: (state: UpdaterState) => void) => () => void;
  };

  // Window control
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
  };

  // External links
  shell: {
    openExternal: (url: string) => Promise<void>;
  };

  // Check if running in Electron
  isElectron: boolean;
}

// Create event listener cleanup functions
function createEventListener<T>(
  channel: string,
  callback: (data: T) => void
): () => void {
  const handler = (_event: Electron.IpcRendererEvent, data: T) => callback(data);
  ipcRenderer.on(channel, handler);

  // Return cleanup function
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

// Expose the API to the renderer process
const desktopAPI: DesktopAPI = {
  // Server control
  server: {
    getStatus: () => ipcRenderer.invoke('server:status'),
    start: () => ipcRenderer.invoke('server:start'),
    stop: () => ipcRenderer.invoke('server:stop'),
    restart: () => ipcRenderer.invoke('server:restart'),
    onStatusChanged: (callback) =>
      createEventListener('server:status-changed', callback),
    onError: (callback) =>
      createEventListener('server:error', callback),
  },

  // Application info
  app: {
    getVersion: () => ipcRenderer.invoke('app:version'),
    getPlatform: () => ipcRenderer.invoke('app:platform'),
  },

  // Update control
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    getState: () => ipcRenderer.invoke('update:state'),
    onStateChanged: (callback) =>
      createEventListener('update:state-changed', callback),
  },

  // Window control
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },

  // External links
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // Flag to indicate running in Electron
  isElectron: true,
};

// Expose API to renderer
contextBridge.exposeInMainWorld('desktopAPI', desktopAPI);

// Also expose a simple check
contextBridge.exposeInMainWorld('isElectron', true);

// Log that preload script is loaded
console.log('[Preload] Desktop API exposed to renderer');
