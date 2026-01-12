/**
 * Update Status Component
 *
 * Shows update status and provides update controls when running in desktop mode.
 * Delegates all update operations to the Electron app via Control Plane.
 */

import { useState, useEffect } from 'react';
import {
  RefreshCw,
  Download,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Monitor,
} from 'lucide-react';
import { desktopAPI, type UpdaterState, type DesktopInfo } from '../lib/desktop-api';

export function UpdateStatus() {
  const [isDesktop, setIsDesktop] = useState(false);
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null);
  const [updateState, setUpdateState] = useState<UpdaterState | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Check if running in desktop mode
  useEffect(() => {
    const checkDesktop = async () => {
      const desktop = desktopAPI.isDesktop();
      setIsDesktop(desktop);

      if (desktop) {
        // Get desktop info
        const info = await desktopAPI.getInfo();
        setDesktopInfo(info);

        // Get initial update state
        const state = await desktopAPI.update.getState();
        setUpdateState(state);

        // Subscribe to state changes
        const unsubscribe = desktopAPI.update.onStateChanged((state) => {
          setUpdateState(state);
        });

        return unsubscribe;
      } else {
        // Check if Control Plane is available
        const available = await desktopAPI.isControlPlaneAvailable();
        if (available) {
          const info = await desktopAPI.getInfo();
          setDesktopInfo(info);
          const state = await desktopAPI.update.getState();
          setUpdateState(state);
        }
      }
    };

    checkDesktop();
  }, []);

  // Check for updates
  const handleCheckUpdates = async () => {
    setIsLoading(true);
    try {
      const state = await desktopAPI.update.check();
      setUpdateState(state);
    } finally {
      setIsLoading(false);
    }
  };

  // Download update
  const handleDownload = async () => {
    setIsLoading(true);
    try {
      const state = await desktopAPI.update.download();
      setUpdateState(state);
    } finally {
      setIsLoading(false);
    }
  };

  // Install update
  const handleInstall = async () => {
    await desktopAPI.update.install();
    // App will restart
  };

  // Don't show if not in desktop mode and no Control Plane
  if (!isDesktop && !desktopInfo) {
    return null;
  }

  const getStatusIcon = () => {
    if (!updateState) return <Monitor className="h-4 w-4" />;

    switch (updateState.status) {
      case 'checking':
      case 'downloading':
        return <Loader2 className="h-4 w-4 animate-spin" />;
      case 'available':
        return <AlertCircle className="h-4 w-4 text-yellow-500" />;
      case 'downloaded':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'error':
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      default:
        return <Monitor className="h-4 w-4" />;
    }
  };

  const getStatusText = () => {
    if (!updateState) return 'Unknown';

    switch (updateState.status) {
      case 'idle':
        return `v${updateState.currentVersion}`;
      case 'checking':
        return 'Checking for updates...';
      case 'available':
        return `Update available: v${updateState.availableVersion}`;
      case 'not-available':
        return `Up to date (v${updateState.currentVersion})`;
      case 'downloading':
        return `Downloading... ${Math.round(updateState.downloadProgress ?? 0)}%`;
      case 'downloaded':
        return `Ready to install v${updateState.availableVersion}`;
      case 'error':
        return `Error: ${updateState.error}`;
      default:
        return 'Unknown';
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {getStatusIcon()}
          <span className="font-medium text-gray-900 dark:text-white">
            Desktop App
          </span>
        </div>
        {desktopInfo && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {desktopInfo.platform}
          </span>
        )}
      </div>

      <div className="text-sm text-gray-600 dark:text-gray-300 mb-3">
        {getStatusText()}
      </div>

      {/* Progress bar for download */}
      {updateState?.status === 'downloading' && (
        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 mb-3">
          <div
            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
            style={{ width: `${updateState.downloadProgress ?? 0}%` }}
          />
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        {/* Check for updates */}
        {(updateState?.status === 'idle' ||
          updateState?.status === 'not-available' ||
          updateState?.status === 'error') && (
          <button
            onClick={handleCheckUpdates}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-md transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            Check for Updates
          </button>
        )}

        {/* Download button */}
        {updateState?.status === 'available' && (
          <button
            onClick={handleDownload}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors disabled:opacity-50"
          >
            <Download className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            Download Update
          </button>
        )}

        {/* Install button */}
        {updateState?.status === 'downloaded' && (
          <button
            onClick={handleInstall}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors"
          >
            <RotateCcw className="h-4 w-4" />
            Restart to Update
          </button>
        )}
      </div>

      {/* Release notes */}
      {updateState?.releaseNotes &&
        (updateState.status === 'available' || updateState.status === 'downloaded') && (
          <details className="mt-3">
            <summary className="text-sm text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
              View release notes
            </summary>
            <div className="mt-2 p-2 bg-gray-50 dark:bg-gray-900 rounded text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap">
              {updateState.releaseNotes}
            </div>
          </details>
        )}
    </div>
  );
}

export default UpdateStatus;
