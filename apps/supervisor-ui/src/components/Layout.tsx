import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  FolderKanban,
  Terminal,
  Settings,
  Activity,
  Bot,
  Play,
} from 'lucide-react';
import { fetchHealth } from '../lib/api';
import clsx from 'clsx';

interface LayoutProps {
  children: React.ReactNode;
}

const navItems = [
  { path: '/projects', labelKey: 'nav.projects', icon: FolderKanban },
  { path: '/agents', labelKey: 'nav.agents', icon: Bot },
  { path: '/executor', labelKey: 'nav.executor', icon: Play },
  { path: '/shell', labelKey: 'nav.shell', icon: Terminal },
  { path: '/settings', labelKey: 'nav.settings', icon: Settings },
];

export default function Layout({ children }: LayoutProps) {
  const { t } = useTranslation();
  const location = useLocation();

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 30000,
  });

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block fixed top-0 left-0 h-full w-64 bg-white border-r border-slate-200 z-40">
        <div className="h-14 flex items-center px-4 border-b border-slate-200">
          <Activity className="text-primary-600" size={24} />
          <h1 className="ml-2 font-bold text-slate-800">Tako Agent</h1>
        </div>

        <nav className="p-4 space-y-1">
          {navItems.map(({ path, labelKey, icon: Icon }) => (
            <Link
              key={path}
              to={path}
              className={clsx(
                'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors',
                location.pathname.startsWith(path)
                  ? 'bg-primary-50 text-primary-700'
                  : 'text-slate-600 hover:bg-slate-100'
              )}
            >
              <Icon size={18} />
              <span>{t(labelKey)}</span>
            </Link>
          ))}
        </nav>

        {/* Status footer */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-slate-200">
          <div className="text-xs text-slate-500 space-y-1">
            <div className="flex items-center gap-2">
              <span
                className={clsx(
                  'w-2 h-2 rounded-full',
                  health?.status === 'ok' ? 'bg-green-500' : 'bg-red-500'
                )}
              />
              <span>Backend: {health?.status ?? 'disconnected'}</span>
            </div>
            <div className="text-slate-400">v{health?.version ?? '?'}</div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="lg:ml-64 pb-16 lg:pb-0 min-h-screen">
        {children}
      </main>

      {/* Mobile Bottom Navigation */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 h-14 bg-white border-t border-slate-200 z-50 flex items-center justify-around px-4 safe-area-pb">
        {navItems.map(({ path, icon: Icon }) => {
          const isActive = location.pathname.startsWith(path);
          return (
            <Link
              key={path}
              to={path}
              className={clsx(
                'flex items-center justify-center p-3 rounded-full transition-colors',
                isActive
                  ? 'text-primary-600 bg-primary-50'
                  : 'text-slate-400 active:bg-slate-100'
              )}
            >
              <Icon size={24} strokeWidth={isActive ? 2.5 : 2} />
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
