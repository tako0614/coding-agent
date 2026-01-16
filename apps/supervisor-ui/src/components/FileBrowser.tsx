/**
 * FileBrowser - Web-based folder selection component
 * Allows browsing directories without native dialog
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Folder,
  FolderOpen,
  HardDrive,
  ChevronRight,
  ArrowUp,
  Loader2,
  Home,
  AlertCircle,
  Check,
  X,
} from 'lucide-react';
import { browseDirectory, type BrowseEntry, type BrowseResult } from '../lib/api';
import clsx from 'clsx';

interface FileBrowserProps {
  onSelect: (path: string) => void;
  onCancel: () => void;
  initialPath?: string;
}

export default function FileBrowser({ onSelect, onCancel, initialPath }: FileBrowserProps) {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState<string>(initialPath || '');
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [isRoot, setIsRoot] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState(initialPath || '');

  // Load directory contents
  const loadDirectory = async (path?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result: BrowseResult = await browseDirectory(path || undefined);
      setCurrentPath(result.path);
      setEntries(result.entries);
      setParentPath(result.parent ?? null);
      setIsRoot(result.isRoot);
      setManualPath(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load directory');
    } finally {
      setIsLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    loadDirectory(initialPath);
  }, []);

  // Navigate to directory
  const navigateTo = (path: string) => {
    loadDirectory(path);
  };

  // Go up one level
  const goUp = () => {
    if (parentPath) {
      loadDirectory(parentPath);
    } else if (!isRoot) {
      loadDirectory(); // Go to root
    }
  };

  // Go to root
  const goToRoot = () => {
    loadDirectory();
  };

  // Handle manual path input
  const handleManualPathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualPath.trim()) {
      loadDirectory(manualPath.trim());
    }
  };

  // Select current directory
  const selectCurrentDirectory = () => {
    if (currentPath) {
      onSelect(currentPath);
    }
  };

  // Build breadcrumb parts
  const getBreadcrumbs = () => {
    if (!currentPath || isRoot) return [];

    const isWindows = currentPath.includes('\\') || /^[A-Z]:/i.test(currentPath);
    const separator = isWindows ? '\\' : '/';
    const parts = currentPath.split(separator).filter(Boolean);

    const crumbs: Array<{ name: string; path: string }> = [];

    if (isWindows && parts[0]) {
      // Windows: First part is drive (e.g., "C:")
      let buildPath = parts[0] + separator;
      crumbs.push({ name: parts[0], path: buildPath });

      for (let i = 1; i < parts.length; i++) {
        buildPath = buildPath + parts[i] + (i < parts.length - 1 ? separator : '');
        crumbs.push({ name: parts[i], path: buildPath });
      }
    } else {
      // Unix
      let buildPath = '/';
      for (let i = 0; i < parts.length; i++) {
        buildPath = buildPath + parts[i] + (i < parts.length - 1 ? '/' : '');
        crumbs.push({ name: parts[i], path: buildPath });
      }
    }

    return crumbs;
  };

  const breadcrumbs = getBreadcrumbs();

  return (
    <div className="flex flex-col h-[70vh] max-h-[500px]">
      {/* Header with path input */}
      <div className="flex-shrink-0 border-b border-slate-200 p-3">
        <form onSubmit={handleManualPathSubmit} className="flex gap-2">
          <input
            type="text"
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            placeholder={t('fileBrowser.pathPlaceholder', 'Enter path...')}
            className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
          <button
            type="submit"
            className="px-3 py-2 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors"
          >
            {t('common.go', 'Go')}
          </button>
        </form>
      </div>

      {/* Breadcrumb navigation */}
      <div className="flex-shrink-0 flex items-center gap-1 px-3 py-2 bg-slate-50 border-b border-slate-200 overflow-x-auto">
        <button
          onClick={goToRoot}
          className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-200 rounded transition-colors"
          title={t('fileBrowser.root', 'Root')}
        >
          <Home size={16} />
        </button>

        {!isRoot && parentPath !== null && (
          <button
            onClick={goUp}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-200 rounded transition-colors"
            title={t('fileBrowser.up', 'Go up')}
          >
            <ArrowUp size={16} />
          </button>
        )}

        <div className="flex items-center gap-0.5 text-sm overflow-x-auto">
          {breadcrumbs.map((crumb, index) => (
            <div key={crumb.path} className="flex items-center">
              {index > 0 && <ChevronRight size={14} className="text-slate-400 mx-0.5" />}
              <button
                onClick={() => navigateTo(crumb.path)}
                className={clsx(
                  'px-1.5 py-0.5 rounded hover:bg-slate-200 transition-colors truncate max-w-[100px]',
                  index === breadcrumbs.length - 1 ? 'text-slate-800 font-medium' : 'text-slate-600'
                )}
                title={crumb.path}
              >
                {crumb.name}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Directory listing */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 size={24} className="animate-spin text-primary-600" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full text-red-500 p-4">
            <AlertCircle size={32} className="mb-2" />
            <p className="text-sm text-center">{error}</p>
            <button
              onClick={() => loadDirectory()}
              className="mt-3 px-3 py-1.5 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
            >
              {t('fileBrowser.retry', 'Go to root')}
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-400 p-4">
            <Folder size={32} className="mb-2" />
            <p className="text-sm">{t('fileBrowser.empty', 'No folders found')}</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => navigateTo(entry.path)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 active:bg-slate-100 transition-colors text-left"
              >
                {entry.isDrive ? (
                  <HardDrive size={20} className="text-slate-500 flex-shrink-0" />
                ) : (
                  <Folder size={20} className="text-amber-500 flex-shrink-0" />
                )}
                <span className="text-sm text-slate-700 truncate">{entry.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Footer with current selection and actions */}
      <div className="flex-shrink-0 border-t border-slate-200 p-3 bg-slate-50">
        <div className="flex items-center gap-2 mb-3">
          <FolderOpen size={16} className="text-primary-600 flex-shrink-0" />
          <span className="text-sm text-slate-600 truncate flex-1" title={currentPath || t('fileBrowser.noSelection', 'No selection')}>
            {currentPath || t('fileBrowser.selectFolder', 'Select a folder')}
          </span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-slate-600 hover:bg-slate-200 rounded-lg transition-colors"
          >
            <X size={16} />
            {t('common.cancel')}
          </button>
          <button
            onClick={selectCurrentDirectory}
            disabled={!currentPath || isRoot}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Check size={16} />
            {t('fileBrowser.select', 'Select')}
          </button>
        </div>
      </div>
    </div>
  );
}
