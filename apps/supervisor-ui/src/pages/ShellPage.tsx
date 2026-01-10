import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal as TerminalIcon, Plus, X, FolderOpen } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface TerminalTab {
  id: string;
  title: string;
  cwd: string;
}

export default function ShellPage() {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [cwd, setCwd] = useState('');
  const terminalRefs = useRef<Map<string, { terminal: Terminal; ws: WebSocket; fitAddon: FitAddon }>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // Create a new terminal tab
  const createTab = useCallback((initialCwd?: string) => {
    const tabId = `tab-${Date.now()}`;
    const workingDir = initialCwd || cwd || '';

    const newTab: TerminalTab = {
      id: tabId,
      title: workingDir ? workingDir.split(/[/\\]/).pop() || 'Terminal' : 'Terminal',
      cwd: workingDir,
    };

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);

    // Initialize terminal after DOM update
    setTimeout(() => initializeTerminal(tabId, workingDir), 0);
  }, [cwd]);

  // Initialize xterm.js terminal
  const initializeTerminal = useCallback((tabId: string, workingDir: string) => {
    const container = document.getElementById(`terminal-${tabId}`);
    if (!container) return;

    // Create terminal
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        cursorAccent: '#1e1e2e',
        selectionBackground: '#585b70',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
      allowProposedApi: true,
    });

    // Add addons
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    // Open terminal in container
    terminal.open(container);
    fitAddon.fit();

    // Connect to WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/terminal?cwd=${encodeURIComponent(workingDir)}&cols=${terminal.cols}&rows=${terminal.rows}`;

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      terminal.writeln('\x1b[32m● Connected to terminal\x1b[0m\r\n');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'output':
            terminal.write(msg.data);
            break;
          case 'session':
            // Update tab title with shell info
            setTabs((prev) =>
              prev.map((tab) =>
                tab.id === tabId
                  ? { ...tab, title: msg.cwd.split(/[/\\]/).pop() || msg.shell }
                  : tab
              )
            );
            break;
          case 'exit':
            terminal.writeln(`\r\n\x1b[33m● Process exited with code ${msg.exitCode}\x1b[0m`);
            break;
        }
      } catch {
        // Raw output
        terminal.write(event.data);
      }
    };

    ws.onclose = () => {
      terminal.writeln('\r\n\x1b[31m● Disconnected from terminal\x1b[0m');
    };

    ws.onerror = () => {
      terminal.writeln('\r\n\x1b[31m● Connection error\x1b[0m');
    };

    // Send input to server
    terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Handle resize
    terminal.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    // Store references
    terminalRefs.current.set(tabId, { terminal, ws, fitAddon });

    // Focus terminal
    terminal.focus();
  }, []);

  // Close a terminal tab
  const closeTab = useCallback((tabId: string) => {
    const ref = terminalRefs.current.get(tabId);
    if (ref) {
      ref.ws.close();
      ref.terminal.dispose();
      terminalRefs.current.delete(tabId);
    }

    setTabs((prev) => {
      const newTabs = prev.filter((tab) => tab.id !== tabId);
      if (activeTabId === tabId && newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      } else if (newTabs.length === 0) {
        setActiveTabId(null);
      }
      return newTabs;
    });
  }, [activeTabId]);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (activeTabId) {
        const ref = terminalRefs.current.get(activeTabId);
        if (ref) {
          ref.fitAddon.fit();
        }
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [activeTabId]);

  // Fit terminal when tab changes
  useEffect(() => {
    if (activeTabId) {
      const ref = terminalRefs.current.get(activeTabId);
      if (ref) {
        setTimeout(() => {
          ref.fitAddon.fit();
          ref.terminal.focus();
        }, 0);
      }
    }
  }, [activeTabId]);

  // Create initial tab
  useEffect(() => {
    if (tabs.length === 0) {
      createTab();
    }
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">{t('shell.title')}</h1>
          <p className="text-slate-500">{t('shell.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <FolderOpen size={18} className="text-slate-500" />
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={t('shell.workingDirectoryPlaceholder')}
              className="w-64 px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          <button
            onClick={() => createTab()}
            className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            <Plus size={18} />
            {t('shell.newTab')}
          </button>
        </div>
      </div>

      {/* Tabs */}
      {tabs.length > 0 && (
        <div className="flex items-center gap-1 bg-slate-800 rounded-t-lg px-2 pt-2">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-t-lg cursor-pointer transition-colors ${
                activeTabId === tab.id
                  ? 'bg-[#1e1e2e] text-white'
                  : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
              }`}
            >
              <TerminalIcon size={14} />
              <span className="text-sm max-w-32 truncate">{tab.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="p-0.5 hover:bg-slate-600 rounded"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Terminal Container */}
      <div
        ref={containerRef}
        className="flex-1 bg-[#1e1e2e] rounded-b-lg overflow-hidden"
        style={{ minHeight: '400px' }}
      >
        {tabs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-500">
            <div className="text-center">
              <TerminalIcon size={48} className="mx-auto mb-4 opacity-50" />
              <p>{t('shell.noTerminals')}</p>
              <button
                onClick={() => createTab()}
                className="mt-4 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
              >
                {t('shell.newTab')}
              </button>
            </div>
          </div>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.id}
              id={`terminal-${tab.id}`}
              className={`h-full w-full p-2 ${activeTabId === tab.id ? '' : 'hidden'}`}
            />
          ))
        )}
      </div>

      <p className="mt-4 text-sm text-slate-500">
        {t('shell.tip')}
      </p>
    </div>
  );
}
