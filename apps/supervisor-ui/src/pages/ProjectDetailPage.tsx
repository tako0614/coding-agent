import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import Editor from '@monaco-editor/react';
import {
  ArrowLeft,
  Loader2,
  File,
  ChevronRight,
  ChevronDown,
  X,
  Plus,
  Trash2,
  RefreshCw,
  FileText,
  Folder,
  XCircle,
} from 'lucide-react';
import {
  fetchProject,
  listFiles,
  readFile,
  writeFile,
  createDirectory,
  deleteFile as deleteFileApi,
  type FileEntry,
} from '../lib/api';
import clsx from 'clsx';

// --- Types ---
interface OpenFile {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  language: string;
  isDirty: boolean;
}

interface TreeNode {
  entry: FileEntry;
  children?: TreeNode[];
  isExpanded?: boolean;
  isLoading?: boolean;
}

// --- Helper Functions ---
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    sql: 'sql',
    graphql: 'graphql',
    vue: 'vue',
    svelte: 'svelte',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    gitignore: 'plaintext',
    env: 'plaintext',
  };
  return languageMap[ext] || 'plaintext';
}

function getFileIcon(entry: FileEntry) {
  if (entry.isDirectory) {
    return <Folder size={14} className="text-amber-500 shrink-0" />;
  }
  const ext = entry.name.split('.').pop()?.toLowerCase() || '';
  const iconColors: Record<string, string> = {
    ts: 'text-blue-500',
    tsx: 'text-blue-500',
    js: 'text-yellow-500',
    jsx: 'text-yellow-500',
    json: 'text-yellow-600',
    md: 'text-slate-500',
    html: 'text-orange-500',
    css: 'text-blue-400',
    py: 'text-green-500',
    go: 'text-cyan-500',
    rs: 'text-orange-600',
  };
  return <FileText size={14} className={clsx('shrink-0', iconColors[ext] || 'text-slate-400')} />;
}

// --- File Tree Component ---
function FileTree({
  nodes,
  onSelect,
  onToggle,
  selectedPath,
  onRefresh,
  onNewFile,
  onNewFolder,
  onDelete,
  level = 0,
}: {
  nodes: TreeNode[];
  onSelect: (entry: FileEntry) => void;
  onToggle: (entry: FileEntry) => void;
  selectedPath: string | null;
  onRefresh: (path: string) => void;
  onNewFile: (parentPath: string) => void;
  onNewFolder: (parentPath: string) => void;
  onDelete: (entry: FileEntry) => void;
  level?: number;
}) {
  return (
    <div className="text-sm">
      {nodes.map((node) => (
        <div key={node.entry.path}>
          <div
            className={clsx(
              'flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-slate-100 group',
              selectedPath === node.entry.path && 'bg-primary-50 text-primary-700'
            )}
            style={{ paddingLeft: `${level * 12 + 8}px` }}
            onClick={() => {
              if (node.entry.isDirectory) {
                onToggle(node.entry);
              } else {
                onSelect(node.entry);
              }
            }}
          >
            {node.entry.isDirectory && (
              <span className="w-4 h-4 flex items-center justify-center shrink-0">
                {node.isLoading ? (
                  <Loader2 size={12} className="animate-spin text-slate-400" />
                ) : node.isExpanded ? (
                  <ChevronDown size={12} className="text-slate-400" />
                ) : (
                  <ChevronRight size={12} className="text-slate-400" />
                )}
              </span>
            )}
            {!node.entry.isDirectory && <span className="w-4 shrink-0" />}
            {getFileIcon(node.entry)}
            <span className="truncate flex-1 text-slate-700">{node.entry.name}</span>

            {/* Action buttons on hover */}
            <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
              {node.entry.isDirectory && (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewFile(node.entry.path);
                    }}
                    className="p-0.5 hover:bg-slate-200 rounded text-slate-500"
                    title="New File"
                  >
                    <File size={12} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewFolder(node.entry.path);
                    }}
                    className="p-0.5 hover:bg-slate-200 rounded text-slate-500"
                    title="New Folder"
                  >
                    <Folder size={12} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRefresh(node.entry.path);
                    }}
                    className="p-0.5 hover:bg-slate-200 rounded text-slate-500"
                    title="Refresh"
                  >
                    <RefreshCw size={12} />
                  </button>
                </>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(node.entry);
                }}
                className="p-0.5 hover:bg-red-100 text-red-500 rounded"
                title="Delete"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>

          {node.entry.isDirectory && node.isExpanded && node.children && (
            <FileTree
              nodes={node.children}
              onSelect={onSelect}
              onToggle={onToggle}
              selectedPath={selectedPath}
              onRefresh={onRefresh}
              onNewFile={onNewFile}
              onNewFolder={onNewFolder}
              onDelete={onDelete}
              level={level + 1}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// --- Editor Tabs ---
function EditorTabs({
  files,
  activeFile,
  onSelect,
  onClose,
}: {
  files: OpenFile[];
  activeFile: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  return (
    <div className="flex bg-slate-100 border-b border-slate-200 overflow-x-auto">
      {files.map((file) => (
        <div
          key={file.path}
          className={clsx(
            'flex items-center gap-2 px-3 py-2 cursor-pointer min-w-0 max-w-[200px] group border-b-2',
            activeFile === file.path
              ? 'bg-white text-slate-800 border-b-primary-500'
              : 'bg-slate-50 text-slate-500 hover:bg-slate-100 border-b-transparent'
          )}
          onClick={() => onSelect(file.path)}
        >
          {getFileIcon({ name: file.name, isDirectory: false } as FileEntry)}
          <span className="truncate text-sm">{file.name}</span>
          {file.isDirty && (
            <span className="w-2 h-2 rounded-full bg-primary-500 shrink-0" title="Unsaved changes" />
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose(file.path);
            }}
            className="p-0.5 hover:bg-slate-200 rounded opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

// --- Main Page ---
export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  // File tree state
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Open files state
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);

  // UI state
  const [sidebarWidth] = useState(240);
  const [isCreatingFile, setIsCreatingFile] = useState<{ type: 'file' | 'folder'; parentPath: string } | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const newItemInputRef = useRef<HTMLInputElement>(null);

  const { data: project, isLoading, error } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => fetchProject(projectId!),
    enabled: !!projectId,
  });

  // Load root directory
  const loadDirectory = useCallback(async (dirPath: string, repoPath: string): Promise<TreeNode[]> => {
    try {
      const result = await listFiles(dirPath, repoPath);
      const sorted = [...result.entries].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      return sorted.map((entry) => ({
        entry,
        isExpanded: false,
        children: entry.isDirectory ? [] : undefined,
      }));
    } catch (err) {
      console.error('Failed to load directory:', err);
      return [];
    }
  }, []);

  // Initial load
  useEffect(() => {
    if (project?.repo_path) {
      loadDirectory('.', project.repo_path).then(setTreeNodes);
    }
  }, [project?.repo_path, loadDirectory]);

  // Toggle directory expansion
  const handleToggleDirectory = useCallback(async (entry: FileEntry) => {
    if (!project?.repo_path) return;

    setTreeNodes((prev) => {
      const updateNode = (nodes: TreeNode[]): TreeNode[] => {
        return nodes.map((node) => {
          if (node.entry.path === entry.path) {
            if (node.isExpanded) {
              return { ...node, isExpanded: false };
            }
            if (!node.children?.length) {
              return { ...node, isLoading: true };
            }
            return { ...node, isExpanded: true };
          }
          if (node.children) {
            return { ...node, children: updateNode(node.children) };
          }
          return node;
        });
      };
      return updateNode(prev);
    });

    const findNode = (nodes: TreeNode[], path: string): TreeNode | null => {
      for (const node of nodes) {
        if (node.entry.path === path) return node;
        if (node.children) {
          const found = findNode(node.children, path);
          if (found) return found;
        }
      }
      return null;
    };

    const currentNode = findNode(treeNodes, entry.path);
    if (!currentNode?.isExpanded && !currentNode?.children?.length) {
      const children = await loadDirectory(entry.path, project.repo_path);
      setTreeNodes((prev) => {
        const updateNode = (nodes: TreeNode[]): TreeNode[] => {
          return nodes.map((node) => {
            if (node.entry.path === entry.path) {
              return { ...node, isExpanded: true, isLoading: false, children };
            }
            if (node.children) {
              return { ...node, children: updateNode(node.children) };
            }
            return node;
          });
        };
        return updateNode(prev);
      });
    }
  }, [project?.repo_path, treeNodes, loadDirectory]);

  // Open file
  const handleOpenFile = useCallback(async (entry: FileEntry) => {
    if (!project?.repo_path || entry.isDirectory) return;

    const existing = openFiles.find((f) => f.path === entry.path);
    if (existing) {
      setActiveFilePath(entry.path);
      setSelectedPath(entry.path);
      return;
    }

    try {
      const result = await readFile(entry.path, project.repo_path);
      const newFile: OpenFile = {
        path: entry.path,
        name: entry.name,
        content: result.content,
        originalContent: result.content,
        language: getLanguageFromPath(entry.path),
        isDirty: false,
      };
      setOpenFiles((prev) => [...prev, newFile]);
      setActiveFilePath(entry.path);
      setSelectedPath(entry.path);
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  }, [project?.repo_path, openFiles]);

  // Close file
  const handleCloseFile = useCallback((path: string) => {
    const file = openFiles.find((f) => f.path === path);
    if (file?.isDirty) {
      if (!confirm('You have unsaved changes. Close anyway?')) {
        return;
      }
    }

    setOpenFiles((prev) => prev.filter((f) => f.path !== path));
    if (activeFilePath === path) {
      const remaining = openFiles.filter((f) => f.path !== path);
      setActiveFilePath(remaining.length > 0 ? remaining[remaining.length - 1].path : null);
    }
  }, [openFiles, activeFilePath]);

  // Update file content
  const handleEditorChange = useCallback((value: string | undefined) => {
    if (!activeFilePath || value === undefined) return;

    setOpenFiles((prev) =>
      prev.map((f) =>
        f.path === activeFilePath
          ? { ...f, content: value, isDirty: value !== f.originalContent }
          : f
      )
    );
  }, [activeFilePath]);

  // Save file mutation
  const saveMutation = useMutation({
    mutationFn: async ({ path, content }: { path: string; content: string }) => {
      if (!project?.repo_path) throw new Error('No repo path');
      return writeFile(path, content, project.repo_path);
    },
    onSuccess: (_, variables) => {
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === variables.path
            ? { ...f, originalContent: variables.content, isDirty: false }
            : f
        )
      );
    },
  });

  // Save current file
  const handleSave = useCallback(() => {
    const activeFile = openFiles.find((f) => f.path === activeFilePath);
    if (!activeFile || !activeFile.isDirty) return;

    saveMutation.mutate({ path: activeFile.path, content: activeFile.content });
  }, [openFiles, activeFilePath, saveMutation]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  // Refresh directory
  const handleRefresh = useCallback(async (path: string) => {
    if (!project?.repo_path) return;

    const children = await loadDirectory(path, project.repo_path);
    setTreeNodes((prev) => {
      const updateNode = (nodes: TreeNode[]): TreeNode[] => {
        return nodes.map((node) => {
          if (node.entry.path === path) {
            return { ...node, children, isExpanded: true };
          }
          if (node.children) {
            return { ...node, children: updateNode(node.children) };
          }
          return node;
        });
      };

      if (path === '.') {
        return children;
      }
      return updateNode(prev);
    });
  }, [project?.repo_path, loadDirectory]);

  // Create new file/folder
  const handleCreateItem = useCallback(async () => {
    if (!isCreatingFile || !newItemName.trim() || !project?.repo_path) return;

    const fullPath = isCreatingFile.parentPath === '.'
      ? newItemName
      : `${isCreatingFile.parentPath}/${newItemName}`;

    try {
      if (isCreatingFile.type === 'folder') {
        await createDirectory(fullPath, project.repo_path);
      } else {
        await writeFile(fullPath, '', project.repo_path);
      }

      await handleRefresh(isCreatingFile.parentPath);

      setIsCreatingFile(null);
      setNewItemName('');
    } catch (err) {
      console.error('Failed to create item:', err);
    }
  }, [isCreatingFile, newItemName, project?.repo_path, handleRefresh]);

  // Delete file/folder
  const deleteMutation = useMutation({
    mutationFn: async (entry: FileEntry) => {
      if (!project?.repo_path) throw new Error('No repo path');
      return deleteFileApi(entry.path, project.repo_path);
    },
    onSuccess: (_, entry) => {
      if (openFiles.some((f) => f.path === entry.path)) {
        handleCloseFile(entry.path);
      }
      const parentPath = entry.path.includes('/')
        ? entry.path.substring(0, entry.path.lastIndexOf('/'))
        : '.';
      handleRefresh(parentPath);
    },
  });

  const handleDelete = useCallback((entry: FileEntry) => {
    if (!confirm(`Delete "${entry.name}"?`)) return;
    deleteMutation.mutate(entry);
  }, [deleteMutation]);

  // Focus new item input
  useEffect(() => {
    if (isCreatingFile && newItemInputRef.current) {
      newItemInputRef.current.focus();
    }
  }, [isCreatingFile]);

  // Handle back navigation
  const handleBack = useCallback(() => {
    const hasUnsaved = openFiles.some((f) => f.isDirty);
    if (hasUnsaved) {
      if (!confirm('You have unsaved changes. Leave anyway?')) {
        return;
      }
    }
    navigate('/projects');
  }, [openFiles, navigate]);

  const activeFile = openFiles.find((f) => f.path === activeFilePath);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <Loader2 className="animate-spin text-primary-600" size={32} />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-50">
        <XCircle className="text-red-400 mb-4" size={48} />
        <h2 className="text-lg font-medium text-slate-800 mb-2">Project not found</h2>
        <button
          onClick={() => navigate('/projects')}
          className="text-primary-600 hover:underline text-sm"
        >
          Go back
        </button>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      {/* Header */}
      <header className="h-14 bg-white border-b border-slate-200 flex items-center px-4 shrink-0">
        <button
          onClick={handleBack}
          className="flex items-center gap-2 px-3 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
        >
          <ArrowLeft size={18} />
          <span className="text-sm font-medium">Back</span>
        </button>
        <div className="mx-4 h-6 w-px bg-slate-200" />
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-slate-800 truncate">{project.name}</h1>
          <p className="text-xs text-slate-400 font-mono truncate">{project.repo_path}</p>
        </div>
        {activeFile?.isDirty && (
          <button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {saveMutation.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : null}
            Save
          </button>
        )}
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar - Explorer */}
        <aside
          className="bg-white border-r border-slate-200 flex flex-col shrink-0"
          style={{ width: sidebarWidth }}
        >
          {/* Explorer Header */}
          <div className="h-10 px-4 flex items-center justify-between text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-100">
            <span>Explorer</span>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => setIsCreatingFile({ type: 'file', parentPath: '.' })}
                className="p-1 hover:bg-slate-100 rounded text-slate-500"
                title="New File"
              >
                <Plus size={14} />
              </button>
              <button
                onClick={() => setIsCreatingFile({ type: 'folder', parentPath: '.' })}
                className="p-1 hover:bg-slate-100 rounded text-slate-500"
                title="New Folder"
              >
                <Folder size={14} />
              </button>
              <button
                onClick={() => handleRefresh('.')}
                className="p-1 hover:bg-slate-100 rounded text-slate-500"
                title="Refresh"
              >
                <RefreshCw size={14} />
              </button>
            </div>
          </div>

          {/* File Tree */}
          <div className="flex-1 overflow-y-auto">
            {/* New item input at root */}
            {isCreatingFile?.parentPath === '.' && (
              <div className="px-2 py-1 flex items-center gap-1" style={{ paddingLeft: '8px' }}>
                {isCreatingFile.type === 'folder' ? (
                  <Folder size={14} className="text-amber-500 shrink-0" />
                ) : (
                  <FileText size={14} className="text-slate-400 shrink-0" />
                )}
                <input
                  ref={newItemInputRef}
                  type="text"
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateItem();
                    if (e.key === 'Escape') {
                      setIsCreatingFile(null);
                      setNewItemName('');
                    }
                  }}
                  onBlur={() => {
                    if (newItemName.trim()) {
                      handleCreateItem();
                    } else {
                      setIsCreatingFile(null);
                    }
                  }}
                  className="flex-1 bg-white border border-primary-500 rounded px-2 py-1 text-sm text-slate-700 outline-none focus:ring-1 focus:ring-primary-500"
                  placeholder={isCreatingFile.type === 'folder' ? 'folder name' : 'file name'}
                />
              </div>
            )}

            <FileTree
              nodes={treeNodes}
              onSelect={handleOpenFile}
              onToggle={handleToggleDirectory}
              selectedPath={selectedPath}
              onRefresh={handleRefresh}
              onNewFile={(parentPath) => setIsCreatingFile({ type: 'file', parentPath })}
              onNewFolder={(parentPath) => setIsCreatingFile({ type: 'folder', parentPath })}
              onDelete={handleDelete}
            />

            {treeNodes.length === 0 && (
              <div className="text-center py-8 text-slate-400">
                <Folder size={32} className="mx-auto mb-2 opacity-50" />
                <p className="text-xs">No files found</p>
              </div>
            )}
          </div>
        </aside>

        {/* Editor Area */}
        <main className="flex-1 flex flex-col overflow-hidden bg-white">
          {/* Tabs */}
          {openFiles.length > 0 && (
            <EditorTabs
              files={openFiles}
              activeFile={activeFilePath}
              onSelect={setActiveFilePath}
              onClose={handleCloseFile}
            />
          )}

          {/* Editor */}
          <div className="flex-1 overflow-hidden">
            {activeFile ? (
              <Editor
                height="100%"
                language={activeFile.language}
                value={activeFile.content}
                onChange={handleEditorChange}
                theme="vs"
                options={{
                  fontSize: 14,
                  fontFamily: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
                  minimap: { enabled: true },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                  wordWrap: 'off',
                  lineNumbers: 'on',
                  renderLineHighlight: 'all',
                  smoothScrolling: true,
                  cursorBlinking: 'smooth',
                  cursorSmoothCaretAnimation: 'on',
                  padding: { top: 8, bottom: 8 },
                }}
              />
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-slate-400">
                <File size={64} className="mb-4 opacity-30" />
                <p className="text-sm">Select a file to start editing</p>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Status Bar */}
      <div className="h-6 bg-primary-600 flex items-center px-4 text-white text-xs shrink-0">
        <span>{activeFile?.language || 'Plain Text'}</span>
        <div className="flex-1" />
        {activeFile?.isDirty && (
          <span className="mr-4">Modified</span>
        )}
        <span className="opacity-75">Ctrl+S to save</span>
      </div>
    </div>
  );
}
