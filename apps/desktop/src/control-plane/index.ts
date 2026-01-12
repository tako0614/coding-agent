/**
 * Control Plane - HTTP API for Desktop Control
 *
 * Provides an HTTP endpoint for the Web UI to communicate with the Electron app.
 * This allows the Web UI to:
 * - Request update checks
 * - Trigger update downloads
 * - Request restart for updates
 * - Get desktop app status
 *
 * The Control Plane runs on a separate port and only accepts connections from localhost.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { ServerManager } from '../main/server-manager';
import { setupAutoUpdater, UpdaterState } from '../main/auto-updater';
import { app } from 'electron';
import log from 'electron-log';

const CONTROL_PLANE_PORT = 3001;

interface ControlPlaneResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Setup the Control Plane HTTP server
 */
export function setupControlPlane(serverManager: ServerManager): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Only allow localhost connections
    const remoteAddress = req.socket.remoteAddress;
    if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1') {
      log.warn('Control Plane: Rejected non-localhost connection', { remoteAddress });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Forbidden' }));
      return;
    }

    // Set CORS headers for localhost
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route handling
    const url = new URL(req.url ?? '/', `http://localhost:${CONTROL_PLANE_PORT}`);
    const pathname = url.pathname;

    handleRoute(pathname, req, res, serverManager);
  });

  server.listen(CONTROL_PLANE_PORT, '127.0.0.1', () => {
    log.info(`Control Plane listening on http://127.0.0.1:${CONTROL_PLANE_PORT}`);
  });

  server.on('error', (error) => {
    log.error('Control Plane server error:', error);
  });
}

/**
 * Handle Control Plane routes
 */
async function handleRoute(
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  serverManager: ServerManager
): Promise<void> {
  const sendJson = (status: number, data: ControlPlaneResponse) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  try {
    switch (pathname) {
      // Health check
      case '/health':
        sendJson(200, { success: true, data: { status: 'ok' } });
        break;

      // Desktop app info
      case '/info':
        sendJson(200, {
          success: true,
          data: {
            version: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            electron: process.versions.electron,
            node: process.versions.node,
            isPackaged: app.isPackaged,
          },
        });
        break;

      // Server status
      case '/server/status':
        sendJson(200, {
          success: true,
          data: serverManager.getStatus(),
        });
        break;

      // Server restart
      case '/server/restart':
        if (req.method !== 'POST') {
          sendJson(405, { success: false, error: 'Method not allowed' });
          return;
        }
        await serverManager.restart();
        sendJson(200, {
          success: true,
          data: serverManager.getStatus(),
        });
        break;

      // Server stop
      case '/server/stop':
        if (req.method !== 'POST') {
          sendJson(405, { success: false, error: 'Method not allowed' });
          return;
        }
        await serverManager.stop();
        sendJson(200, {
          success: true,
          data: serverManager.getStatus(),
        });
        break;

      // Server start
      case '/server/start':
        if (req.method !== 'POST') {
          sendJson(405, { success: false, error: 'Method not allowed' });
          return;
        }
        await serverManager.start();
        sendJson(200, {
          success: true,
          data: serverManager.getStatus(),
        });
        break;

      // Update status
      case '/update/status':
        {
          const updater = setupAutoUpdater();
          sendJson(200, {
            success: true,
            data: updater.getState(),
          });
        }
        break;

      // Check for updates
      case '/update/check':
        if (req.method !== 'POST') {
          sendJson(405, { success: false, error: 'Method not allowed' });
          return;
        }
        {
          const updater = setupAutoUpdater();
          const updateInfo = await updater.checkForUpdates();
          sendJson(200, {
            success: true,
            data: {
              state: updater.getState(),
              updateInfo,
            },
          });
        }
        break;

      // Download update
      case '/update/download':
        if (req.method !== 'POST') {
          sendJson(405, { success: false, error: 'Method not allowed' });
          return;
        }
        {
          const updater = setupAutoUpdater();
          await updater.downloadUpdate();
          sendJson(200, {
            success: true,
            data: updater.getState(),
          });
        }
        break;

      // Install update (restart and apply)
      case '/update/install':
        if (req.method !== 'POST') {
          sendJson(405, { success: false, error: 'Method not allowed' });
          return;
        }
        {
          const updater = setupAutoUpdater();
          const state = updater.getState();

          if (state.status !== 'downloaded') {
            sendJson(400, {
              success: false,
              error: 'No update downloaded. Please download first.',
            });
            return;
          }

          // Send response before quitting
          sendJson(200, {
            success: true,
            data: { message: 'Restarting to apply update...' },
          });

          // Give the response time to be sent
          setTimeout(() => {
            updater.quitAndInstall();
          }, 500);
        }
        break;

      // Not found
      default:
        sendJson(404, { success: false, error: 'Not found' });
    }
  } catch (error) {
    log.error('Control Plane route error:', error);
    sendJson(500, {
      success: false,
      error: error instanceof Error ? error.message : 'Internal error',
    });
  }
}

/**
 * Type declarations for Web UI integration
 */
export interface ControlPlaneAPI {
  health: () => Promise<ControlPlaneResponse>;
  info: () => Promise<ControlPlaneResponse>;
  server: {
    status: () => Promise<ControlPlaneResponse>;
    start: () => Promise<ControlPlaneResponse>;
    stop: () => Promise<ControlPlaneResponse>;
    restart: () => Promise<ControlPlaneResponse>;
  };
  update: {
    status: () => Promise<ControlPlaneResponse>;
    check: () => Promise<ControlPlaneResponse>;
    download: () => Promise<ControlPlaneResponse>;
    install: () => Promise<ControlPlaneResponse>;
  };
}

/**
 * Control Plane URL for Web UI to use
 */
export const CONTROL_PLANE_URL = `http://127.0.0.1:${CONTROL_PLANE_PORT}`;
