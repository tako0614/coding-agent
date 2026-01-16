/**
 * Desktop API utilities
 * Provides fallbacks for web environment
 * Supports both Tauri and Electron
 */

// Check if running in Tauri
export const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

// Check if running in Electron
export const isElectron = typeof window !== 'undefined' && 'desktopAPI' in window;

// Check if running in any desktop environment
export const isDesktop = isTauri || isElectron;

// Dynamic import of Tauri APIs to avoid errors in web environment
let tauriDialog: typeof import('@tauri-apps/plugin-dialog') | null = null;

async function loadTauriDialog() {
  if (isTauri && !tauriDialog) {
    try {
      tauriDialog = await import('@tauri-apps/plugin-dialog');
    } catch {
      console.warn('Failed to load Tauri dialog plugin');
    }
  }
  return tauriDialog;
}

// Type for Electron's desktop API
interface DesktopAPI {
  dialog: {
    openFolder: () => Promise<string | null>;
  };
}

declare global {
  interface Window {
    desktopAPI?: DesktopAPI;
  }
}

/**
 * Open a folder picker dialog
 * Uses native dialog in desktop apps (Tauri/Electron), returns null in web
 */
export async function openFolderDialog(): Promise<string | null> {
  // Try Electron first
  if (isElectron && window.desktopAPI?.dialog) {
    try {
      return await window.desktopAPI.dialog.openFolder();
    } catch (error) {
      console.error('Failed to open folder dialog via Electron:', error);
      return null;
    }
  }

  // Try Tauri
  if (isTauri) {
    const dialog = await loadTauriDialog();
    if (!dialog) {
      return null;
    }

    try {
      const selected = await dialog.open({
        directory: true,
        multiple: false,
        title: 'Select Project Folder',
      });
      return selected as string | null;
    } catch (error) {
      console.error('Failed to open folder dialog via Tauri:', error);
      return null;
    }
  }

  // Not in desktop environment
  return null;
}
