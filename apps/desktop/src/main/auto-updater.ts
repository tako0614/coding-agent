/**
 * Auto-Updater Module
 *
 * Handles automatic updates for the desktop application.
 * Updates include both Electron shell and bundled Node.js backend.
 *
 * Flow:
 * 1. Check for updates (on startup and periodically)
 * 2. Download update in background
 * 3. Notify user that update is ready
 * 4. User clicks "Restart to Update"
 * 5. App quits, installer runs, app restarts with new version
 */

import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';
import { app, dialog, BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import log from 'electron-log';

// Configure electron-updater logging
autoUpdater.logger = log;

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdaterState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  releaseNotes?: string;
  releaseDate?: string;
  downloadProgress?: number;
  error?: string;
}

export interface AutoUpdaterEvents {
  'state-changed': (state: UpdaterState) => void;
  'update-available': (info: UpdateInfo) => void;
  'update-downloaded': (info: UpdateInfo) => void;
  'error': (error: Error) => void;
}

class AutoUpdaterManager extends EventEmitter {
  private state: UpdaterState;
  private updateInfo?: UpdateInfo;
  private checkInterval?: NodeJS.Timeout;

  constructor() {
    super();

    this.state = {
      status: 'idle',
      currentVersion: app.getVersion(),
    };

    this.setupAutoUpdater();
  }

  /**
   * Configure electron-updater
   */
  private setupAutoUpdater(): void {
    // Don't auto-download - let user decide
    autoUpdater.autoDownload = false;

    // Don't auto-install on quit - let user choose when to restart
    autoUpdater.autoInstallOnAppQuit = false;

    // Allow pre-release updates in development
    autoUpdater.allowPrerelease = !app.isPackaged;

    // Event handlers
    autoUpdater.on('checking-for-update', () => {
      log.info('Checking for updates...');
      this.updateState({ status: 'checking' });
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      log.info('Update available:', info.version);
      this.updateInfo = info;
      this.updateState({
        status: 'available',
        availableVersion: info.version,
        releaseNotes: this.formatReleaseNotes(info.releaseNotes),
        releaseDate: info.releaseDate,
      });
      this.emit('update-available', info);

      // Show notification to user
      this.showUpdateNotification(info);
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      log.info('No update available. Current version:', info.version);
      this.updateState({ status: 'not-available' });
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      log.debug(`Download progress: ${progress.percent.toFixed(1)}%`);
      this.updateState({
        status: 'downloading',
        downloadProgress: progress.percent,
      });
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      log.info('Update downloaded:', info.version);
      this.updateInfo = info;
      this.updateState({
        status: 'downloaded',
        downloadProgress: 100,
      });
      this.emit('update-downloaded', info);

      // Show restart prompt
      this.showRestartPrompt(info);
    });

    autoUpdater.on('error', (error: Error) => {
      log.error('Auto-updater error:', error);
      this.updateState({
        status: 'error',
        error: error.message,
      });
      this.emit('error', error);
    });
  }

  /**
   * Format release notes for display
   */
  private formatReleaseNotes(notes: unknown): string | undefined {
    if (!notes) return undefined;

    if (typeof notes === 'string') {
      return notes;
    }

    // If it's an array of release notes
    if (Array.isArray(notes)) {
      return notes.map((note: { note?: string | null }) => note.note ?? '').join('\n\n');
    }

    return undefined;
  }

  /**
   * Show notification that update is available
   */
  private showUpdateNotification(info: UpdateInfo): void {
    const focusedWindow = BrowserWindow.getFocusedWindow();

    dialog.showMessageBox(focusedWindow ?? undefined as unknown as BrowserWindow, {
      type: 'info',
      title: 'Update Available',
      message: `A new version (${info.version}) is available.`,
      detail: 'Would you like to download and install it now?',
      buttons: ['Download', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        this.downloadUpdate();
      }
    });
  }

  /**
   * Show prompt to restart and install
   */
  private showRestartPrompt(info: UpdateInfo): void {
    const focusedWindow = BrowserWindow.getFocusedWindow();

    dialog.showMessageBox(focusedWindow ?? undefined as unknown as BrowserWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'The update will be installed when you restart the application.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        this.quitAndInstall();
      }
    });
  }

  /**
   * Update internal state and emit event
   */
  private updateState(partial: Partial<UpdaterState>): void {
    this.state = { ...this.state, ...partial };
    this.emit('state-changed', this.state);
  }

  /**
   * Check for updates
   */
  async checkForUpdates(): Promise<UpdateInfo | null> {
    if (this.state.status === 'checking' || this.state.status === 'downloading') {
      log.info('Already checking or downloading update');
      return null;
    }

    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.updateInfo ?? null;
    } catch (error) {
      log.error('Failed to check for updates:', error);
      return null;
    }
  }

  /**
   * Download available update
   */
  async downloadUpdate(): Promise<void> {
    if (this.state.status !== 'available') {
      log.info('No update available to download');
      return;
    }

    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      log.error('Failed to download update:', error);
    }
  }

  /**
   * Quit and install the downloaded update
   */
  quitAndInstall(): void {
    if (this.state.status !== 'downloaded') {
      log.warn('No update downloaded to install');
      return;
    }

    log.info('Quitting and installing update...');

    // Give the app a moment to clean up
    setImmediate(() => {
      autoUpdater.quitAndInstall(false, true);
    });
  }

  /**
   * Get current updater state
   */
  getState(): UpdaterState {
    return { ...this.state };
  }

  /**
   * Start periodic update checks
   */
  startPeriodicChecks(intervalMs = 60 * 60 * 1000): void {
    // Check every hour by default
    this.stopPeriodicChecks();

    this.checkInterval = setInterval(() => {
      this.checkForUpdates();
    }, intervalMs);

    log.info(`Started periodic update checks (every ${intervalMs / 1000 / 60} minutes)`);
  }

  /**
   * Stop periodic update checks
   */
  stopPeriodicChecks(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
  }
}

// Singleton instance
let updaterInstance: AutoUpdaterManager | null = null;

/**
 * Get or create the auto-updater instance
 */
export function setupAutoUpdater(): AutoUpdaterManager {
  if (!updaterInstance) {
    updaterInstance = new AutoUpdaterManager();
    // Start periodic checks
    updaterInstance.startPeriodicChecks();
  }
  return updaterInstance;
}
