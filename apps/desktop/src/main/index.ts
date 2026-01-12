/**
 * Supervisor Agent Desktop - Main Process
 *
 * Responsibilities:
 * - Manage backend server lifecycle (start/stop/restart)
 * - Create and manage main window
 * - Handle system tray integration
 * - Coordinate auto-updates
 * - Expose Control Plane API for Web UI
 */

import { app, BrowserWindow, ipcMain, Menu, Tray, shell, nativeImage } from 'electron';
import { join } from 'path';
import { ServerManager } from './server-manager';
import { setupAutoUpdater, UpdaterState } from './auto-updater';
import { setupControlPlane } from '../control-plane';
import log from 'electron-log';

// Configure logging
log.transports.file.level = 'info';
log.transports.console.level = 'debug';

// Global references to prevent garbage collection
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverManager: ServerManager | null = null;
let isQuitting = false;

// Server configuration
const SERVER_PORT = process.env['SUPERVISOR_PORT']
  ? parseInt(process.env['SUPERVISOR_PORT'], 10)
  : 3000;

/**
 * Create the main application window
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Supervisor Agent',
    icon: getIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false, // Don't show until ready
  });

  // Load the web UI from the backend server
  const serverUrl = `http://localhost:${SERVER_PORT}`;
  mainWindow.loadURL(serverUrl);

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    log.info('Main window ready');
  });

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle window close - minimize to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      log.info('Window hidden to tray');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open DevTools in development
  if (process.env['NODE_ENV'] === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

/**
 * Get the appropriate icon path for the current platform
 */
function getIconPath(): string {
  const resourcesPath = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(__dirname, '../../resources');

  if (process.platform === 'win32') {
    return join(resourcesPath, 'icon.ico');
  } else if (process.platform === 'darwin') {
    return join(resourcesPath, 'icon.icns');
  }
  return join(resourcesPath, 'icon.png');
}

/**
 * Create system tray icon and menu
 */
function createTray(): void {
  const iconPath = getIconPath();
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Supervisor Agent');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Supervisor Agent',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: 'Open in Browser',
      click: () => {
        shell.openExternal(`http://localhost:${SERVER_PORT}`);
      },
    },
    { type: 'separator' },
    {
      label: 'Server Status',
      enabled: false,
      id: 'server-status',
    },
    {
      label: 'Restart Server',
      click: async () => {
        await serverManager?.restart();
      },
    },
    { type: 'separator' },
    {
      label: 'Check for Updates',
      click: () => {
        mainWindow?.webContents.send('update:check-requested');
        setupAutoUpdater().checkForUpdates();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Double-click to show window
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

/**
 * Update tray menu with server status
 */
function updateTrayStatus(status: string): void {
  if (!tray) return;

  const contextMenu = tray.contextMenu;
  if (contextMenu) {
    const statusItem = contextMenu.getMenuItemById('server-status');
    if (statusItem) {
      statusItem.label = `Server: ${status}`;
    }
    tray.setContextMenu(contextMenu);
  }
}

/**
 * Setup IPC handlers for renderer process communication
 */
function setupIpcHandlers(): void {
  // Server control
  ipcMain.handle('server:status', () => {
    return serverManager?.getStatus() ?? { running: false };
  });

  ipcMain.handle('server:restart', async () => {
    await serverManager?.restart();
    return serverManager?.getStatus();
  });

  ipcMain.handle('server:stop', async () => {
    await serverManager?.stop();
    return serverManager?.getStatus();
  });

  ipcMain.handle('server:start', async () => {
    await serverManager?.start();
    return serverManager?.getStatus();
  });

  // App info
  ipcMain.handle('app:version', () => {
    return app.getVersion();
  });

  ipcMain.handle('app:platform', () => {
    return process.platform;
  });

  // Update control
  ipcMain.handle('update:check', async () => {
    const updater = setupAutoUpdater();
    return updater.checkForUpdates();
  });

  ipcMain.handle('update:download', async () => {
    const updater = setupAutoUpdater();
    return updater.downloadUpdate();
  });

  ipcMain.handle('update:install', () => {
    const updater = setupAutoUpdater();
    updater.quitAndInstall();
  });

  ipcMain.handle('update:state', () => {
    const updater = setupAutoUpdater();
    return updater.getState();
  });

  // Window control
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.handle('window:close', () => {
    mainWindow?.close();
  });

  // Open external URL
  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    shell.openExternal(url);
  });
}

/**
 * Initialize the application
 */
async function initialize(): Promise<void> {
  log.info('Initializing Supervisor Agent Desktop');
  log.info(`App version: ${app.getVersion()}`);
  log.info(`Electron version: ${process.versions.electron}`);
  log.info(`Platform: ${process.platform}`);

  // Create server manager
  serverManager = new ServerManager({
    port: SERVER_PORT,
    onStatusChange: (status) => {
      updateTrayStatus(status);
      mainWindow?.webContents.send('server:status-changed', { status });
    },
    onError: (error) => {
      log.error('Server error:', error);
      mainWindow?.webContents.send('server:error', { error });
    },
    onLog: (message) => {
      log.debug(`[Server] ${message}`);
    },
  });

  // Start the backend server
  try {
    await serverManager.start();
    log.info('Backend server started');
  } catch (error) {
    log.error('Failed to start backend server:', error);
  }

  // Setup IPC handlers
  setupIpcHandlers();

  // Setup Control Plane API
  setupControlPlane(serverManager);

  // Create window and tray
  createWindow();
  createTray();

  // Setup auto-updater
  const updater = setupAutoUpdater();
  updater.on('state-changed', (state: UpdaterState) => {
    mainWindow?.webContents.send('update:state-changed', state);
  });

  // Check for updates on startup (after a short delay)
  setTimeout(() => {
    updater.checkForUpdates();
  }, 5000);
}

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  log.info('Another instance is already running, quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, focus our window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // App ready
  app.whenReady().then(initialize);
}

// Handle window-all-closed
app.on('window-all-closed', () => {
  // On macOS, apps typically stay open until explicitly quit
  if (process.platform !== 'darwin') {
    // Don't quit - keep running in tray
  }
});

// Handle activate (macOS)
app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

// Handle before-quit
app.on('before-quit', async () => {
  isQuitting = true;
  log.info('Application quitting...');

  // Stop the server gracefully
  if (serverManager) {
    await serverManager.stop();
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});
