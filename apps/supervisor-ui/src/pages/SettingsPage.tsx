import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Server, RefreshCw, Globe, Key, Eye, EyeOff, Check, Loader2, Github, AppWindow, ExternalLink } from 'lucide-react';
import { fetchHealth, fetchSettings, updateSettings, fetchCopilotStatus, fetchApplications, focusApplication } from '../lib/api';
import { languages } from '../i18n';

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  // API Key states
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);

  // Copilot API states
  const [githubToken, setGithubToken] = useState('');
  const [showGithubToken, setShowGithubToken] = useState(false);

  const { data: health, refetch: refetchHealth } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
  });

  const { data: settings, refetch: refetchSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  });

  const { data: copilotStatus } = useQuery({
    queryKey: ['copilotStatus'],
    queryFn: fetchCopilotStatus,
    refetchInterval: 5000, // Poll every 5 seconds
  });

  const updateSettingsMutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['copilotStatus'] });
      setOpenaiKey('');
      setAnthropicKey('');
      setGithubToken('');
    },
  });

  const handleSaveApiKeys = () => {
    const updates: Record<string, string> = {};
    if (openaiKey) updates.openai_api_key = openaiKey;
    if (anthropicKey) updates.anthropic_api_key = anthropicKey;
    if (Object.keys(updates).length > 0) {
      updateSettingsMutation.mutate(updates);
    }
  };

  const handleSaveCopilotSettings = () => {
    if (githubToken) {
      updateSettingsMutation.mutate({ github_token: githubToken });
    }
  };

  const handleClearOpenaiKey = () => {
    updateSettingsMutation.mutate({ openai_api_key: '' });
  };

  const handleClearAnthropicKey = () => {
    updateSettingsMutation.mutate({ anthropic_api_key: '' });
  };

  const handleClearGithubToken = () => {
    updateSettingsMutation.mutate({ github_token: '' });
  };

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
  };

  return (
    <div className="px-4 sm:px-6 py-4 sm:py-6">
      <div className="mb-4 sm:mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-800">{t('settings.title')}</h1>
        <p className="text-slate-500 text-sm sm:text-base">{t('settings.subtitle')}</p>
      </div>

      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        {/* API Keys */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base sm:text-lg font-semibold text-slate-800 flex items-center gap-2">
              <Key size={20} />
              API Keys
            </h2>
            <button
              onClick={() => refetchSettings()}
              className="p-2.5 sm:p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 active:bg-slate-200 rounded-lg transition-colors"
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <p className="text-sm text-slate-500 mb-4">
            Configure API keys for AI services. Keys are stored securely and take precedence over environment variables.
          </p>
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
            {/* OpenAI API Key */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                OpenAI API Key
                {settings?.openai_api_key_set && (
                  <span className="ml-2 text-xs text-green-600 font-normal">
                    <Check size={12} className="inline mr-1" />
                    Configured ({settings.openai_api_key})
                  </span>
                )}
              </label>
              <div className="relative">
                <input
                  type={showOpenaiKey ? 'text' : 'password'}
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  placeholder={settings?.openai_api_key_set ? 'Enter new key to update' : 'sk-...'}
                  className="w-full px-3 py-3 sm:py-2 pr-20 text-base border border-slate-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
                <button
                  type="button"
                  onClick={() => setShowOpenaiKey(!showOpenaiKey)}
                  className="absolute right-10 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 active:text-slate-800"
                >
                  {showOpenaiKey ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
                {settings?.openai_api_key_set && (
                  <button
                    type="button"
                    onClick={handleClearOpenaiKey}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-red-400 hover:text-red-600 active:text-red-800 text-xs"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Anthropic API Key */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Anthropic API Key
                {settings?.anthropic_api_key_set && (
                  <span className="ml-2 text-xs text-green-600 font-normal">
                    <Check size={12} className="inline mr-1" />
                    Configured ({settings.anthropic_api_key})
                  </span>
                )}
              </label>
              <div className="relative">
                <input
                  type={showAnthropicKey ? 'text' : 'password'}
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                  placeholder={settings?.anthropic_api_key_set ? 'Enter new key to update' : 'sk-ant-...'}
                  className="w-full px-3 py-3 sm:py-2 pr-20 text-base border border-slate-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
                <button
                  type="button"
                  onClick={() => setShowAnthropicKey(!showAnthropicKey)}
                  className="absolute right-10 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 active:text-slate-800"
                >
                  {showAnthropicKey ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
                {settings?.anthropic_api_key_set && (
                  <button
                    type="button"
                    onClick={handleClearAnthropicKey}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-red-400 hover:text-red-600 active:text-red-800 text-xs"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="mt-4">
            <button
              onClick={handleSaveApiKeys}
              disabled={(!openaiKey && !anthropicKey) || updateSettingsMutation.isPending}
              className="w-full sm:w-auto px-4 py-3 sm:py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 active:bg-primary-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {updateSettingsMutation.isPending && <Loader2 size={16} className="animate-spin" />}
              Save API Keys
            </button>
          </div>
        </div>

        {/* GitHub Copilot API */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base sm:text-lg font-semibold text-slate-800 flex items-center gap-2">
              <Github size={20} />
              GitHub Copilot API
            </h2>
            {/* Status indicator - only show when token is set */}
            {settings?.github_token_set && (
              <div className="flex items-center gap-2 text-sm">
                <span
                  className={`w-2 h-2 rounded-full ${
                    copilotStatus?.running && copilotStatus?.healthy
                      ? 'bg-green-500'
                      : copilotStatus?.running
                      ? 'bg-yellow-500 animate-pulse'
                      : 'bg-red-500'
                  }`}
                />
                <span className="text-slate-500">
                  {copilotStatus?.running && copilotStatus?.healthy
                    ? 'Running'
                    : copilotStatus?.running
                    ? 'Starting...'
                    : 'Not running'}
                </span>
              </div>
            )}
          </div>

          {copilotStatus?.error && settings?.github_token_set && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {copilotStatus.error}
            </div>
          )}

          <p className="text-sm text-slate-500 mb-4">
            Use GitHub Copilot as an OpenAI-compatible API proxy. Set your GitHub token below and the proxy will start automatically.
          </p>

          {/* GitHub Token */}
          <div className="max-w-md">
            <label className="block text-sm font-medium text-slate-700 mb-1">
              GitHub Token
              {settings?.github_token_set && (
                <span className="ml-2 text-xs text-green-600 font-normal">
                  <Check size={12} className="inline mr-1" />
                  Configured ({settings.github_token})
                </span>
              )}
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showGithubToken ? 'text' : 'password'}
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder={settings?.github_token_set ? 'Enter new token to update' : 'ghp_...'}
                  className="w-full px-3 py-2 pr-10 border border-slate-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
                <button
                  type="button"
                  onClick={() => setShowGithubToken(!showGithubToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showGithubToken ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              <button
                onClick={handleSaveCopilotSettings}
                disabled={!githubToken || updateSettingsMutation.isPending}
                className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {updateSettingsMutation.isPending && <Loader2 size={16} className="animate-spin" />}
                Save
              </button>
              {settings?.github_token_set && (
                <button
                  onClick={handleClearGithubToken}
                  className="px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-2">
              Get your token from{' '}
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary-600 hover:underline"
              >
                GitHub Settings → Tokens
              </a>
            </p>
          </div>
        </div>

        {/* Language Selection */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
          <h2 className="text-base sm:text-lg font-semibold text-slate-800 flex items-center gap-2 mb-4">
            <Globe size={20} />
            {t('settings.language')}
          </h2>
          <div className="space-y-2">
            {languages.map((lang) => (
              <button
                key={lang.code}
                onClick={() => changeLanguage(lang.code)}
                className={`w-full text-left px-4 py-3.5 sm:py-3 rounded-lg border transition-colors active:scale-[0.98] ${
                  i18n.language === lang.code
                    ? 'border-primary-500 bg-primary-50 text-primary-700'
                    : 'border-slate-200 hover:bg-slate-50 active:bg-slate-100'
                }`}
              >
                <span className="font-medium">{lang.nativeName}</span>
                <span className="text-slate-500 ml-2">({lang.name})</span>
              </button>
            ))}
          </div>
        </div>

        {/* Backend Status */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base sm:text-lg font-semibold text-slate-800 flex items-center gap-2">
              <Server size={20} />
              {t('settings.backendStatus')}
            </h2>
            <button
              onClick={() => refetchHealth()}
              className="p-2.5 sm:p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 active:bg-slate-200 rounded-lg transition-colors"
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-slate-500">{t('settings.status')}</dt>
              <dd className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${
                    health?.status === 'ok' ? 'bg-green-500' : 'bg-red-500'
                  }`}
                />
                {health?.status ?? 'Unknown'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">{t('settings.version')}</dt>
              <dd className="font-mono text-sm">{health?.version ?? '-'}</dd>
            </div>
          </dl>
        </div>

        {/* Running Applications */}
        <RunningApplications />

      </div>
    </div>
  );
}

// Running Applications Component
function RunningApplications() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['applications'],
    queryFn: fetchApplications,
    refetchInterval: 5000,
  });

  const handleFocus = async (pid: number) => {
    try {
      await focusApplication(pid);
    } catch (error) {
      console.error('Failed to focus application:', error);
    }
  };

  const apps = data?.applications || [];

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6 lg:col-span-2">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base sm:text-lg font-semibold text-slate-800 flex items-center gap-2">
          <AppWindow size={20} />
          起動中のアプリケーション
        </h2>
        <button
          onClick={() => refetch()}
          className="p-2.5 sm:p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 active:bg-slate-200 rounded-lg transition-colors"
        >
          <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {isLoading && apps.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-slate-400">
          <Loader2 size={24} className="animate-spin" />
        </div>
      ) : apps.length === 0 ? (
        <p className="text-sm text-slate-500 text-center py-4">
          表示可能なアプリケーションがありません
        </p>
      ) : (
        <div className="space-y-1 max-h-[300px] overflow-y-auto">
          {apps.map((app) => (
            <div
              key={app.pid}
              className="flex items-center justify-between px-3 py-2 hover:bg-slate-50 rounded-lg group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm text-slate-700 truncate">
                    {app.title || app.name}
                  </span>
                  <span className="text-xs text-slate-400">
                    ({app.name})
                  </span>
                </div>
                {app.path && (
                  <div className="text-xs text-slate-400 truncate">
                    {app.path}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="text-xs text-slate-400">
                  PID: {app.pid}
                </span>
                <button
                  onClick={() => handleFocus(app.pid)}
                  className="p-1.5 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded transition-colors"
                  title="フォーカス"
                >
                  <ExternalLink size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
