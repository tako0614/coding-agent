/**
 * Tauri API utilities
 * Provides fallbacks for web environment
 */

// Check if running in Tauri
export const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

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

/**
 * Open a folder picker dialog
 * Uses Tauri's native dialog in desktop app, returns null in web
 */
export async function openFolderDialog(): Promise<string | null> {
  if (!isTauri) {
    return null;
  }

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
    console.error('Failed to open folder dialog:', error);
    return null;
  }
}
