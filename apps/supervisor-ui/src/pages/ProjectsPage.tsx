import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Trash2,
  Loader2,
  FolderKanban,
  Calendar,
  FolderOpen,
  GitBranch,
} from 'lucide-react';
import { fetchProjects, createProject, deleteProject, type Project } from '../lib/api';
import { openFolderDialog, isTauri } from '../lib/tauri';

function ProjectCard({ project, onDelete }: { project: Project; onDelete: () => void }) {
  const { t } = useTranslation();

  return (
    <Link
      to={`/projects/${project.project_id}`}
      className="block bg-white rounded-xl border border-slate-200 p-5 hover:shadow-lg hover:border-primary-300 transition-all group"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <FolderKanban size={20} className="text-primary-500" />
            <h3 className="font-semibold text-slate-800 truncate text-lg">
              {project.name}
            </h3>
          </div>
          {project.description && (
            <p className="text-sm text-slate-500 line-clamp-2 mb-3">
              {project.description}
            </p>
          )}
          <div className="flex items-center gap-4 text-xs text-slate-400">
            <div className="flex items-center gap-1">
              <GitBranch size={12} />
              <span className="truncate max-w-[200px]" title={project.repo_path}>
                {project.repo_path.split(/[/\\]/).pop()}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Calendar size={12} />
              <span>{new Date(project.created_at).toLocaleDateString()}</span>
            </div>
          </div>
        </div>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }}
          className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
          title={t('common.delete')}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </Link>
  );
}

export default function ProjectsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showNewProject, setShowNewProject] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [folderPath, setFolderPath] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    refetchInterval: 10000,
  });

  const createMutation = useMutation({
    mutationFn: ({ name, description, repo_path }: { name: string; description?: string; repo_path: string }) =>
      createProject({ name, description, repo_path }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setShowNewProject(false);
      setName('');
      setDescription('');
      setFolderPath('');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const handleBrowseFolder = async () => {
    const selected = await openFolderDialog();
    if (selected) {
      setFolderPath(selected);
      // Auto-fill name from folder name if empty
      if (!name) {
        const folderName = selected.split(/[/\\]/).pop() || '';
        setName(folderName);
      }
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">{t('projects.title')}</h1>
          <p className="text-slate-500 mt-1">{t('projects.subtitle')}</p>
        </div>
        <button
          onClick={() => setShowNewProject(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-primary-600 text-white rounded-xl hover:bg-primary-700 transition-colors shadow-sm"
        >
          <Plus size={18} />
          {t('projects.newProject')}
        </button>
      </div>

      {/* New Project Modal */}
      {showNewProject && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-xl font-semibold mb-4">{t('projects.newProject')}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim() && folderPath.trim()) {
                  createMutation.mutate({
                    name: name.trim(),
                    description: description.trim() || undefined,
                    repo_path: folderPath.trim(),
                  });
                }
              }}
            >
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    {t('projects.name')}
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('projects.namePlaceholder')}
                    className="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    autoFocus
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    {t('projects.description')}
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('projects.descriptionPlaceholder')}
                    className="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-primary-500 resize-none"
                    rows={2}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    <FolderOpen size={14} className="inline mr-1.5" />
                    {t('projects.repoPath')}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={folderPath}
                      onChange={(e) => setFolderPath(e.target.value)}
                      placeholder={t('projects.repoPathPlaceholder')}
                      className="flex-1 px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                      required
                    />
                    {isTauri && (
                      <button
                        type="button"
                        onClick={handleBrowseFolder}
                        className="px-4 py-3 bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-colors"
                        title={t('projects.browse')}
                      >
                        <FolderOpen size={18} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => {
                    setShowNewProject(false);
                    setName('');
                    setDescription('');
                    setFolderPath('');
                  }}
                  className="px-4 py-2.5 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending || !name.trim() || !folderPath.trim()}
                  className="flex items-center gap-2 px-5 py-2.5 bg-primary-600 text-white rounded-xl hover:bg-primary-700 disabled:opacity-50 transition-colors"
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

      {/* Projects Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={32} className="animate-spin text-primary-600" />
        </div>
      ) : error ? (
        <div className="text-center py-16 text-red-600">
          {t('common.error')}: {error.message}
        </div>
      ) : data?.projects.length === 0 ? (
        <div className="text-center py-16">
          <FolderKanban size={48} className="mx-auto text-slate-300 mb-4" />
          <p className="text-slate-500 mb-2">{t('projects.noProjects')}</p>
          <p className="text-sm text-slate-400">{t('projects.createFirst')}</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {data?.projects.map((project) => (
            <ProjectCard
              key={project.project_id}
              project={project}
              onDelete={() => deleteMutation.mutate(project.project_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
