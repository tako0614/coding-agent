"use strict";
const electron = require("electron");
const path = require("path");
const child_process = require("child_process");
const log = require("electron-log");
const electronUpdater = require("electron-updater");
const events = require("events");
const http = require("http");
class ServerManager {
  process = null;
  status = "stopped";
  port;
  options;
  startedAt;
  lastError;
  healthCheckInterval;
  restartAttempts = 0;
  maxRestartAttempts = 3;
  constructor(options) {
    this.options = options;
    this.port = options.port;
  }
  /**
   * Get the path to the backend server
   */
  getServerPath() {
    if (electron.app.isPackaged) {
      return path.join(process.resourcesPath, "backend", "server.js");
    } else {
      return path.join(__dirname, "../../../supervisor-backend/dist/server.js");
    }
  }
  /**
   * Get the path to Node.js executable
   */
  getNodePath() {
    if (electron.app.isPackaged) {
      return process.execPath.includes("electron") ? "node" : process.execPath;
    }
    return "node";
  }
  /**
   * Start the backend server
   */
  async start() {
    if (this.status === "running" || this.status === "starting") {
      log.info("Server already running or starting");
      return;
    }
    this.setStatus("starting");
    log.info("Starting backend server...");
    const serverPath = this.getServerPath();
    const nodePath = this.getNodePath();
    log.info(`Server path: ${serverPath}`);
    log.info(`Node path: ${nodePath}`);
    try {
      this.process = child_process.spawn(nodePath, [serverPath], {
        cwd: electron.app.isPackaged ? path.join(process.resourcesPath, "backend") : path.join(__dirname, "../../../supervisor-backend"),
        env: {
          ...process.env,
          PORT: String(this.port),
          NODE_ENV: electron.app.isPackaged ? "production" : "development",
          // Prevent the server from opening a browser
          BROWSER: "none"
        },
        stdio: ["ignore", "pipe", "pipe"],
        // On Windows, use shell to handle .cmd extensions
        shell: process.platform === "win32"
      });
      this.process.stdout?.on("data", (data) => {
        const message = data.toString().trim();
        if (message) {
          this.options.onLog?.(message);
          if (message.includes("Server running") || message.includes(`listening on port ${this.port}`)) {
            this.setStatus("running");
            this.startedAt = /* @__PURE__ */ new Date();
            this.restartAttempts = 0;
            log.info("Backend server started successfully");
            this.startHealthCheck();
          }
        }
      });
      this.process.stderr?.on("data", (data) => {
        const message = data.toString().trim();
        if (message) {
          log.warn(`[Server stderr] ${message}`);
          this.options.onLog?.(message);
        }
      });
      this.process.on("exit", (code, signal) => {
        log.info(`Server process exited with code ${code}, signal ${signal}`);
        this.stopHealthCheck();
        this.process = null;
        if (this.status !== "stopping") {
          this.setStatus("error");
          this.lastError = `Server exited unexpectedly (code: ${code})`;
          this.options.onError?.(this.lastError);
          if (this.restartAttempts < this.maxRestartAttempts) {
            this.restartAttempts++;
            log.info(`Auto-restarting server (attempt ${this.restartAttempts}/${this.maxRestartAttempts})`);
            setTimeout(() => this.start(), 2e3);
          }
        } else {
          this.setStatus("stopped");
        }
      });
      this.process.on("error", (error) => {
        log.error("Server process error:", error);
        this.setStatus("error");
        this.lastError = error.message;
        this.options.onError?.(error.message);
      });
      await this.waitForReady();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Failed to start server:", message);
      this.setStatus("error");
      this.lastError = message;
      this.options.onError?.(message);
      throw error;
    }
  }
  /**
   * Wait for the server to be ready
   */
  async waitForReady(timeoutMs = 3e4) {
    const startTime = Date.now();
    const checkInterval = 500;
    while (Date.now() - startTime < timeoutMs) {
      if (this.status === "running") {
        return;
      }
      if (this.status === "error") {
        throw new Error(this.lastError || "Server failed to start");
      }
      try {
        const response = await fetch(`http://localhost:${this.port}/api/health`, {
          signal: AbortSignal.timeout(1e3)
        });
        if (response.ok) {
          this.setStatus("running");
          this.startedAt = /* @__PURE__ */ new Date();
          return;
        }
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }
    log.warn("Server startup timeout, but process is still running");
  }
  /**
   * Stop the backend server
   */
  async stop() {
    if (this.status === "stopped" || this.status === "stopping") {
      return;
    }
    this.setStatus("stopping");
    this.stopHealthCheck();
    log.info("Stopping backend server...");
    if (!this.process) {
      this.setStatus("stopped");
      return;
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          log.warn("Force killing server process");
          this.process.kill("SIGKILL");
        }
      }, 1e4);
      const cleanup = () => {
        clearTimeout(timeout);
        this.process = null;
        this.setStatus("stopped");
        log.info("Backend server stopped");
        resolve();
      };
      this.process.once("exit", cleanup);
      if (process.platform === "win32") {
        this.process.kill();
      } else {
        this.process.kill("SIGTERM");
      }
    });
  }
  /**
   * Restart the backend server
   */
  async restart() {
    log.info("Restarting backend server...");
    await this.stop();
    await this.start();
  }
  /**
   * Get current server state
   */
  getStatus() {
    return {
      running: this.status === "running",
      status: this.status,
      pid: this.process?.pid,
      port: this.port,
      startedAt: this.startedAt?.toISOString(),
      error: this.lastError
    };
  }
  /**
   * Check if server is healthy
   */
  async checkHealth() {
    try {
      const response = await fetch(`http://localhost:${this.port}/api/health`, {
        signal: AbortSignal.timeout(5e3)
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  /**
   * Start periodic health checks
   */
  startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(async () => {
      if (this.status !== "running") return;
      const healthy = await this.checkHealth();
      if (!healthy) {
        log.warn("Server health check failed");
      }
    }, 3e4);
  }
  /**
   * Stop health checks
   */
  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = void 0;
    }
  }
  /**
   * Update status and notify listeners
   */
  setStatus(status) {
    this.status = status;
    this.options.onStatusChange?.(status);
  }
}
electronUpdater.autoUpdater.logger = log;
class AutoUpdaterManager extends events.EventEmitter {
  state;
  updateInfo;
  checkInterval;
  constructor() {
    super();
    this.state = {
      status: "idle",
      currentVersion: electron.app.getVersion()
    };
    this.setupAutoUpdater();
  }
  /**
   * Configure electron-updater
   */
  setupAutoUpdater() {
    electronUpdater.autoUpdater.autoDownload = false;
    electronUpdater.autoUpdater.autoInstallOnAppQuit = false;
    electronUpdater.autoUpdater.allowPrerelease = !electron.app.isPackaged;
    electronUpdater.autoUpdater.on("checking-for-update", () => {
      log.info("Checking for updates...");
      this.updateState({ status: "checking" });
    });
    electronUpdater.autoUpdater.on("update-available", (info) => {
      log.info("Update available:", info.version);
      this.updateInfo = info;
      this.updateState({
        status: "available",
        availableVersion: info.version,
        releaseNotes: this.formatReleaseNotes(info.releaseNotes),
        releaseDate: info.releaseDate
      });
      this.emit("update-available", info);
      this.showUpdateNotification(info);
    });
    electronUpdater.autoUpdater.on("update-not-available", (info) => {
      log.info("No update available. Current version:", info.version);
      this.updateState({ status: "not-available" });
    });
    electronUpdater.autoUpdater.on("download-progress", (progress) => {
      log.debug(`Download progress: ${progress.percent.toFixed(1)}%`);
      this.updateState({
        status: "downloading",
        downloadProgress: progress.percent
      });
    });
    electronUpdater.autoUpdater.on("update-downloaded", (info) => {
      log.info("Update downloaded:", info.version);
      this.updateInfo = info;
      this.updateState({
        status: "downloaded",
        downloadProgress: 100
      });
      this.emit("update-downloaded", info);
      this.showRestartPrompt(info);
    });
    electronUpdater.autoUpdater.on("error", (error) => {
      log.error("Auto-updater error:", error);
      this.updateState({
        status: "error",
        error: error.message
      });
      this.emit("error", error);
    });
  }
  /**
   * Format release notes for display
   */
  formatReleaseNotes(notes) {
    if (!notes) return void 0;
    if (typeof notes === "string") {
      return notes;
    }
    if (Array.isArray(notes)) {
      return notes.map((note) => note.note ?? "").join("\n\n");
    }
    return void 0;
  }
  /**
   * Show notification that update is available
   */
  showUpdateNotification(info) {
    const focusedWindow = electron.BrowserWindow.getFocusedWindow();
    electron.dialog.showMessageBox(focusedWindow ?? void 0, {
      type: "info",
      title: "Update Available",
      message: `A new version (${info.version}) is available.`,
      detail: "Would you like to download and install it now?",
      buttons: ["Download", "Later"],
      defaultId: 0
    }).then(({ response }) => {
      if (response === 0) {
        this.downloadUpdate();
      }
    });
  }
  /**
   * Show prompt to restart and install
   */
  showRestartPrompt(info) {
    const focusedWindow = electron.BrowserWindow.getFocusedWindow();
    electron.dialog.showMessageBox(focusedWindow ?? void 0, {
      type: "info",
      title: "Update Ready",
      message: `Version ${info.version} has been downloaded.`,
      detail: "The update will be installed when you restart the application.",
      buttons: ["Restart Now", "Later"],
      defaultId: 0
    }).then(({ response }) => {
      if (response === 0) {
        this.quitAndInstall();
      }
    });
  }
  /**
   * Update internal state and emit event
   */
  updateState(partial) {
    this.state = { ...this.state, ...partial };
    this.emit("state-changed", this.state);
  }
  /**
   * Check for updates
   */
  async checkForUpdates() {
    if (this.state.status === "checking" || this.state.status === "downloading") {
      log.info("Already checking or downloading update");
      return null;
    }
    try {
      const result = await electronUpdater.autoUpdater.checkForUpdates();
      return result?.updateInfo ?? null;
    } catch (error) {
      log.error("Failed to check for updates:", error);
      return null;
    }
  }
  /**
   * Download available update
   */
  async downloadUpdate() {
    if (this.state.status !== "available") {
      log.info("No update available to download");
      return;
    }
    try {
      await electronUpdater.autoUpdater.downloadUpdate();
    } catch (error) {
      log.error("Failed to download update:", error);
    }
  }
  /**
   * Quit and install the downloaded update
   */
  quitAndInstall() {
    if (this.state.status !== "downloaded") {
      log.warn("No update downloaded to install");
      return;
    }
    log.info("Quitting and installing update...");
    setImmediate(() => {
      electronUpdater.autoUpdater.quitAndInstall(false, true);
    });
  }
  /**
   * Get current updater state
   */
  getState() {
    return { ...this.state };
  }
  /**
   * Start periodic update checks
   */
  startPeriodicChecks(intervalMs = 60 * 60 * 1e3) {
    this.stopPeriodicChecks();
    this.checkInterval = setInterval(() => {
      this.checkForUpdates();
    }, intervalMs);
    log.info(`Started periodic update checks (every ${intervalMs / 1e3 / 60} minutes)`);
  }
  /**
   * Stop periodic update checks
   */
  stopPeriodicChecks() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = void 0;
    }
  }
}
let updaterInstance = null;
function setupAutoUpdater() {
  if (!updaterInstance) {
    updaterInstance = new AutoUpdaterManager();
    updaterInstance.startPeriodicChecks();
  }
  return updaterInstance;
}
const CONTROL_PLANE_PORT = 3001;
function setupControlPlane(serverManager2) {
  const server = http.createServer((req, res) => {
    const remoteAddress = req.socket.remoteAddress;
    if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1" && remoteAddress !== "::ffff:127.0.0.1") {
      log.warn("Control Plane: Rejected non-localhost connection", { remoteAddress });
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Forbidden" }));
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://localhost:${CONTROL_PLANE_PORT}`);
    const pathname = url.pathname;
    handleRoute(pathname, req, res, serverManager2);
  });
  server.listen(CONTROL_PLANE_PORT, "127.0.0.1", () => {
    log.info(`Control Plane listening on http://127.0.0.1:${CONTROL_PLANE_PORT}`);
  });
  server.on("error", (error) => {
    log.error("Control Plane server error:", error);
  });
}
async function handleRoute(pathname, req, res, serverManager2) {
  const sendJson = (status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  try {
    switch (pathname) {
      // Health check
      case "/health":
        sendJson(200, { success: true, data: { status: "ok" } });
        break;
      // Desktop app info
      case "/info":
        sendJson(200, {
          success: true,
          data: {
            version: electron.app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            electron: process.versions.electron,
            node: process.versions.node,
            isPackaged: electron.app.isPackaged
          }
        });
        break;
      // Server status
      case "/server/status":
        sendJson(200, {
          success: true,
          data: serverManager2.getStatus()
        });
        break;
      // Server restart
      case "/server/restart":
        if (req.method !== "POST") {
          sendJson(405, { success: false, error: "Method not allowed" });
          return;
        }
        await serverManager2.restart();
        sendJson(200, {
          success: true,
          data: serverManager2.getStatus()
        });
        break;
      // Server stop
      case "/server/stop":
        if (req.method !== "POST") {
          sendJson(405, { success: false, error: "Method not allowed" });
          return;
        }
        await serverManager2.stop();
        sendJson(200, {
          success: true,
          data: serverManager2.getStatus()
        });
        break;
      // Server start
      case "/server/start":
        if (req.method !== "POST") {
          sendJson(405, { success: false, error: "Method not allowed" });
          return;
        }
        await serverManager2.start();
        sendJson(200, {
          success: true,
          data: serverManager2.getStatus()
        });
        break;
      // Update status
      case "/update/status":
        {
          const updater = setupAutoUpdater();
          sendJson(200, {
            success: true,
            data: updater.getState()
          });
        }
        break;
      // Check for updates
      case "/update/check":
        if (req.method !== "POST") {
          sendJson(405, { success: false, error: "Method not allowed" });
          return;
        }
        {
          const updater = setupAutoUpdater();
          const updateInfo = await updater.checkForUpdates();
          sendJson(200, {
            success: true,
            data: {
              state: updater.getState(),
              updateInfo
            }
          });
        }
        break;
      // Download update
      case "/update/download":
        if (req.method !== "POST") {
          sendJson(405, { success: false, error: "Method not allowed" });
          return;
        }
        {
          const updater = setupAutoUpdater();
          await updater.downloadUpdate();
          sendJson(200, {
            success: true,
            data: updater.getState()
          });
        }
        break;
      // Install update (restart and apply)
      case "/update/install":
        if (req.method !== "POST") {
          sendJson(405, { success: false, error: "Method not allowed" });
          return;
        }
        {
          const updater = setupAutoUpdater();
          const state = updater.getState();
          if (state.status !== "downloaded") {
            sendJson(400, {
              success: false,
              error: "No update downloaded. Please download first."
            });
            return;
          }
          sendJson(200, {
            success: true,
            data: { message: "Restarting to apply update..." }
          });
          setTimeout(() => {
            updater.quitAndInstall();
          }, 500);
        }
        break;
      // Not found
      default:
        sendJson(404, { success: false, error: "Not found" });
    }
  } catch (error) {
    log.error("Control Plane route error:", error);
    sendJson(500, {
      success: false,
      error: error instanceof Error ? error.message : "Internal error"
    });
  }
}
log.transports.file.level = "info";
log.transports.console.level = "debug";
let mainWindow = null;
let tray = null;
let serverManager = null;
let isQuitting = false;
const SERVER_PORT = process.env["SUPERVISOR_PORT"] ? parseInt(process.env["SUPERVISOR_PORT"], 10) : 3e3;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "Supervisor Agent",
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    show: false
    // Don't show until ready
  });
  const serverUrl = `http://localhost:${SERVER_PORT}`;
  mainWindow.loadURL(serverUrl);
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    log.info("Main window ready");
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    electron.shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      log.info("Window hidden to tray");
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (process.env["NODE_ENV"] === "development") {
    mainWindow.webContents.openDevTools();
  }
}
function getIconPath() {
  const resourcesPath = electron.app.isPackaged ? path.join(process.resourcesPath, "resources") : path.join(__dirname, "../../resources");
  if (process.platform === "win32") {
    return path.join(resourcesPath, "icon.ico");
  } else if (process.platform === "darwin") {
    return path.join(resourcesPath, "icon.icns");
  }
  return path.join(resourcesPath, "icon.png");
}
function createTray() {
  const iconPath = getIconPath();
  const icon = electron.nativeImage.createFromPath(iconPath);
  tray = new electron.Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Supervisor Agent");
  const contextMenu = electron.Menu.buildFromTemplate([
    {
      label: "Open Supervisor Agent",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    {
      label: "Open in Browser",
      click: () => {
        electron.shell.openExternal(`http://localhost:${SERVER_PORT}`);
      }
    },
    { type: "separator" },
    {
      label: "Server Status",
      enabled: false,
      id: "server-status"
    },
    {
      label: "Restart Server",
      click: async () => {
        await serverManager?.restart();
      }
    },
    { type: "separator" },
    {
      label: "Check for Updates",
      click: () => {
        mainWindow?.webContents.send("update:check-requested");
        setupAutoUpdater().checkForUpdates();
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        electron.app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}
function updateTrayStatus(status) {
  if (!tray) return;
  const contextMenu = electron.Menu.buildFromTemplate([
    {
      label: "Open Supervisor Agent",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    {
      label: "Open in Browser",
      click: () => {
        electron.shell.openExternal(`http://localhost:${SERVER_PORT}`);
      }
    },
    { type: "separator" },
    {
      label: `Server: ${status}`,
      enabled: false
    },
    {
      label: "Restart Server",
      click: async () => {
        await serverManager?.restart();
      }
    },
    { type: "separator" },
    {
      label: "Check for Updates",
      click: () => {
        mainWindow?.webContents.send("update:check-requested");
        setupAutoUpdater().checkForUpdates();
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        electron.app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
}
function setupIpcHandlers() {
  electron.ipcMain.handle("server:status", () => {
    return serverManager?.getStatus() ?? { running: false };
  });
  electron.ipcMain.handle("server:restart", async () => {
    await serverManager?.restart();
    return serverManager?.getStatus();
  });
  electron.ipcMain.handle("server:stop", async () => {
    await serverManager?.stop();
    return serverManager?.getStatus();
  });
  electron.ipcMain.handle("server:start", async () => {
    await serverManager?.start();
    return serverManager?.getStatus();
  });
  electron.ipcMain.handle("app:version", () => {
    return electron.app.getVersion();
  });
  electron.ipcMain.handle("app:platform", () => {
    return process.platform;
  });
  electron.ipcMain.handle("update:check", async () => {
    const updater = setupAutoUpdater();
    return updater.checkForUpdates();
  });
  electron.ipcMain.handle("update:download", async () => {
    const updater = setupAutoUpdater();
    return updater.downloadUpdate();
  });
  electron.ipcMain.handle("update:install", () => {
    const updater = setupAutoUpdater();
    updater.quitAndInstall();
  });
  electron.ipcMain.handle("update:state", () => {
    const updater = setupAutoUpdater();
    return updater.getState();
  });
  electron.ipcMain.handle("window:minimize", () => {
    mainWindow?.minimize();
  });
  electron.ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  electron.ipcMain.handle("window:close", () => {
    mainWindow?.close();
  });
  electron.ipcMain.handle("shell:openExternal", (_event, url) => {
    electron.shell.openExternal(url);
  });
}
async function initialize() {
  log.info("Initializing Supervisor Agent Desktop");
  log.info(`App version: ${electron.app.getVersion()}`);
  log.info(`Electron version: ${process.versions.electron}`);
  log.info(`Platform: ${process.platform}`);
  serverManager = new ServerManager({
    port: SERVER_PORT,
    onStatusChange: (status) => {
      updateTrayStatus(status);
      mainWindow?.webContents.send("server:status-changed", { status });
    },
    onError: (error) => {
      log.error("Server error:", error);
      mainWindow?.webContents.send("server:error", { error });
    },
    onLog: (message) => {
      log.debug(`[Server] ${message}`);
    }
  });
  try {
    await serverManager.start();
    log.info("Backend server started");
  } catch (error) {
    log.error("Failed to start backend server:", error);
  }
  setupIpcHandlers();
  setupControlPlane(serverManager);
  createWindow();
  createTray();
  const updater = setupAutoUpdater();
  updater.on("state-changed", (state) => {
    mainWindow?.webContents.send("update:state-changed", state);
  });
  setTimeout(() => {
    updater.checkForUpdates();
  }, 5e3);
}
const gotTheLock = electron.app.requestSingleInstanceLock();
if (!gotTheLock) {
  log.info("Another instance is already running, quitting");
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  electron.app.whenReady().then(initialize);
}
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") ;
});
electron.app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});
electron.app.on("before-quit", async () => {
  isQuitting = true;
  log.info("Application quitting...");
  if (serverManager) {
    await serverManager.stop();
  }
});
process.on("uncaughtException", (error) => {
  log.error("Uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection:", reason);
});
