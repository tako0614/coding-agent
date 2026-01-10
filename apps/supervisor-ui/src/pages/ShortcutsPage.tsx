import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Play,
  Trash2,
  Loader2,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import {
  fetchShortcuts,
  createShortcut,
  executeShortcut,
  deleteShortcut,
  type Shortcut,
  type ShellResult,
} from '../lib/api';

function ShortcutCard({
  shortcut,
  onExecute,
  onDelete,
  executing,
  result,
}: {
  shortcut: Shortcut;
  onExecute: () => void;
  onDelete: () => void;
  executing: boolean;
  result?: ShellResult;
}) {
  const { t } = useTranslation();
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1">
          <h3 className="font-medium text-slate-800">{shortcut.name}</h3>
          {shortcut.description && (
            <p className="text-sm text-slate-500 mt-1">{shortcut.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onExecute}
            disabled={executing}
            className="p-2 text-green-600 hover:bg-green-50 rounded-lg transition-colors disabled:opacity-50"
            title={t('common.execute')}
          >
            {executing ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Play size={16} />
            )}
          </button>
          <button
            onClick={onDelete}
            className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
            title={t('common.delete')}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="bg-slate-50 rounded px-3 py-2 font-mono text-sm text-slate-700">
        {shortcut.command}
      </div>

      {shortcut.category && (
        <div className="mt-2">
          <span className="inline-block px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded">
            {shortcut.category}
          </span>
        </div>
      )}

      {result && (
        <div className="mt-3 border-t border-slate-200 pt-3">
          <div className="flex items-center gap-2 mb-2">
            {result.exitCode === 0 ? (
              <CheckCircle size={14} className="text-green-500" />
            ) : (
              <XCircle size={14} className="text-red-500" />
            )}
            <span className="text-xs text-slate-500">
              {t('shortcuts.exitCode')}: {result.exitCode} ({result.durationMs}ms)
            </span>
          </div>
          {result.stdout && (
            <pre className="text-xs bg-slate-100 p-2 rounded overflow-x-auto max-h-32">
              {result.stdout.slice(0, 500)}
            </pre>
          )}
          {result.stderr && (
            <pre className="text-xs bg-red-50 text-red-700 p-2 rounded overflow-x-auto max-h-32 mt-2">
              {result.stderr.slice(0, 500)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function ShortcutsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [executing, setExecuting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ShellResult>>({});

  const [newShortcut, setNewShortcut] = useState({
    name: '',
    command: '',
    description: '',
    category: '',
  });

  const { data, isLoading } = useQuery({
    queryKey: ['shortcuts'],
    queryFn: () => fetchShortcuts(),
  });

  const createMutation = useMutation({
    mutationFn: createShortcut,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shortcuts'] });
      setShowNew(false);
      setNewShortcut({ name: '', command: '', description: '', category: '' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteShortcut,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shortcuts'] });
    },
  });

  const handleExecute = async (shortcut: Shortcut) => {
    setExecuting(shortcut.id);
    try {
      const { result } = await executeShortcut(shortcut.id);
      setResults((prev) => ({ ...prev, [shortcut.id]: result }));
    } catch (error) {
      console.error('Execute error:', error);
    } finally {
      setExecuting(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">{t('shortcuts.title')}</h1>
          <p className="text-slate-500">{t('shortcuts.subtitle')}</p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
        >
          <Plus size={18} />
          {t('shortcuts.newShortcut')}
        </button>
      </div>

      {/* New Shortcut Modal */}
      {showNew && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6">
            <h2 className="text-xl font-semibold mb-4">{t('shortcuts.createShortcut')}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                createMutation.mutate(newShortcut);
              }}
            >
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    {t('shortcuts.name')}
                  </label>
                  <input
                    type="text"
                    value={newShortcut.name}
                    onChange={(e) =>
                      setNewShortcut({ ...newShortcut, name: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    {t('shortcuts.command')}
                  </label>
                  <input
                    type="text"
                    value={newShortcut.command}
                    onChange={(e) =>
                      setNewShortcut({ ...newShortcut, command: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    {t('shortcuts.descriptionOptional')}
                  </label>
                  <input
                    type="text"
                    value={newShortcut.description}
                    onChange={(e) =>
                      setNewShortcut({ ...newShortcut, description: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    {t('shortcuts.categoryOptional')}
                  </label>
                  <input
                    type="text"
                    value={newShortcut.category}
                    onChange={(e) =>
                      setNewShortcut({ ...newShortcut, category: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    placeholder={t('shortcuts.categoryPlaceholder')}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setShowNew(false)}
                  className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
                >
                  {createMutation.isPending && (
                    <Loader2 size={18} className="animate-spin" />
                  )}
                  {t('common.create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Shortcuts Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={32} className="animate-spin text-primary-600" />
        </div>
      ) : data?.shortcuts.length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          {t('shortcuts.noShortcuts')}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data?.shortcuts.map((shortcut) => (
            <ShortcutCard
              key={shortcut.id}
              shortcut={shortcut}
              onExecute={() => handleExecute(shortcut)}
              onDelete={() => deleteMutation.mutate(shortcut.id)}
              executing={executing === shortcut.id}
              result={results[shortcut.id]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
