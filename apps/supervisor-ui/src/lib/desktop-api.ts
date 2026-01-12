/**
 * Desktop API Client
 *
 * Provides a unified interface for communicating with the Electron desktop app.
 * Works in two modes:
 * 1. Electron mode: Uses preload API (IPC) for direct communication
 * 2. Browser mode: Uses Control Plane HTTP API
 *
 * The Web UI should use this API for:
 * - Checking for updates
 * - Triggering update downloads
 * - Requesting restart for updates
 * - Getting desktop app info
 */

// Control Plane URL (used when not in Electron)
const CONTROL_PLANE_URL = 'http://127.0.0.1:3001';

// Type definitions
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

export interface DesktopInfo {
  version: string;
  platform: string;
  arch?: string;
  electron?: string;
  node?: string;
  isPackaged?: boolean;
}

// Check if running in Electron
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { isElectron?: boolean }).isElectron;
}

// Get the desktop API from preload (if available)
function getPreloadAPI(): DesktopPreloadAPI | null {
  if (isElectron()) {
    return (window as unknown as { desktopAPI?: DesktopPreloadAPI }).desktopAPI ?? null;
  }
  return null;
}

// Preload API type (matches preload/index.ts)
interface DesktopPreloadAPI {
  server: {
    getStatus: () => Promise<ServerState>;
    start: () => Promise<ServerState>;
    stop: () => Promise<ServerState>;
    restart: () => Promise<ServerState>;
    onStatusChanged: (callback: (state: { status: string }) => void) => () => void;
    onError: (callback: (error: { error: string }) => void) => () => void;
  };
  app: {
    getVersion: () => Promise<string>;
    getPlatform: () => Promise<string>;
  };
  update: {
    check: () => Promise<unknown>;
    download: () => Promise<void>;
    install: () => void;
    getState: () => Promise<UpdaterState>;
    onStateChanged: (callback: (state: UpdaterState) => void) => () => void;
  };
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
  isElectron: boolean;
}

// HTTP fetch helper for Control Plane
async function controlPlaneRequest<T>(
  endpoint: string,
  method: 'GET' | 'POST' = 'GET'
): Promise<T> {
  const response = await fetch(`${CONTROL_PLANE_URL}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
  });

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error || 'Request failed');
  }

  return data.data as T;
}

/**
 * Desktop API - Unified interface for desktop functionality
 */
export const desktopAPI = {
  /**
   * Check if running in desktop mode
   */
  isDesktop: isElectron,

  /**
   * Check if Control Plane is available (when not in Electron)
   */
  async isControlPlaneAvailable(): Promise<boolean> {
    if (isElectron()) return true;

    try {
      const response = await fetch(`${CONTROL_PLANE_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  },

  /**
   * Get desktop app info
   */
  async getInfo(): Promise<DesktopInfo | null> {
    const preload = getPreloadAPI();

    if (preload) {
      const [version, platform] = await Promise.all([
        preload.app.getVersion(),
        preload.app.getPlatform(),
      ]);
      return { version, platform };
    }

    // Try Control Plane
    try {
      return await controlPlaneRequest<DesktopInfo>('/info');
    } catch {
      return null;
    }
  },

  /**
   * Server control
   */
  server: {
    async getStatus(): Promise<ServerState | null> {
      const preload = getPreloadAPI();

      if (preload) {
        return preload.server.getStatus();
      }

      try {
        return await controlPlaneRequest<ServerState>('/server/status');
      } catch {
        return null;
      }
    },

    async restart(): Promise<ServerState | null> {
      const preload = getPreloadAPI();

      if (preload) {
        return preload.server.restart();
      }

      try {
        return await controlPlaneRequest<ServerState>('/server/restart', 'POST');
      } catch {
        return null;
      }
    },

    async start(): Promise<ServerState | null> {
      const preload = getPreloadAPI();

      if (preload) {
        return preload.server.start();
      }

      try {
        return await controlPlaneRequest<ServerState>('/server/start', 'POST');
      } catch {
        return null;
      }
    },

    async stop(): Promise<ServerState | null> {
      const preload = getPreloadAPI();

      if (preload) {
        return preload.server.stop();
      }

      try {
        return await controlPlaneRequest<ServerState>('/server/stop', 'POST');
      } catch {
        return null;
      }
    },

    onStatusChanged(callback: (state: { status: string }) => void): () => void {
      const preload = getPreloadAPI();
      if (preload) {
        return preload.server.onStatusChanged(callback);
      }
      // No event support via Control Plane - would need WebSocket
      return () => {};
    },
  },

  /**
   * Update control
   */
  update: {
    async getState(): Promise<UpdaterState | null> {
      const preload = getPreloadAPI();

      if (preload) {
        return preload.update.getState();
      }

      try {
        return await controlPlaneRequest<UpdaterState>('/update/status');
      } catch {
        return null;
      }
    },

    async check(): Promise<UpdaterState | null> {
      const preload = getPreloadAPI();

      if (preload) {
        await preload.update.check();
        return preload.update.getState();
      }

      try {
        const result = await controlPlaneRequest<{ state: UpdaterState }>('/update/check', 'POST');
        return result.state;
      } catch {
        return null;
      }
    },

    async download(): Promise<UpdaterState | null> {
      const preload = getPreloadAPI();

      if (preload) {
        await preload.update.download();
        return preload.update.getState();
      }

      try {
        return await controlPlaneRequest<UpdaterState>('/update/download', 'POST');
      } catch {
        return null;
      }
    },

    async install(): Promise<void> {
      const preload = getPreloadAPI();

      if (preload) {
        preload.update.install();
        return;
      }

      try {
        await controlPlaneRequest('/update/install', 'POST');
      } catch {
        // Expected - app will restart
      }
    },

    onStateChanged(callback: (state: UpdaterState) => void): () => void {
      const preload = getPreloadAPI();
      if (preload) {
        return preload.update.onStateChanged(callback);
      }
      // No event support via Control Plane
      return () => {};
    },
  },

  /**
   * Window control (only works in Electron)
   */
  window: {
    async minimize(): Promise<void> {
      const preload = getPreloadAPI();
      if (preload) {
        await preload.window.minimize();
      }
    },

    async maximize(): Promise<void> {
      const preload = getPreloadAPI();
      if (preload) {
        await preload.window.maximize();
      }
    },

    async close(): Promise<void> {
      const preload = getPreloadAPI();
      if (preload) {
        await preload.window.close();
      }
    },
  },

  /**
   * Open external URL
   */
  async openExternal(url: string): Promise<void> {
    const preload = getPreloadAPI();

    if (preload) {
      await preload.shell.openExternal(url);
    } else {
      // Fallback to window.open
      window.open(url, '_blank');
    }
  },
};

export default desktopAPI;
