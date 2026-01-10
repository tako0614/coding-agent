import type { Project } from '../api/routes/projects.js';
import { db } from './db.js';

type ProjectRow = {
  project_id: string;
  name: string;
  description: string | null;
  repo_path: string;
  created_at: string;
  updated_at: string;
};

const columns = [
  'project_id',
  'name',
  'description',
  'repo_path',
  'created_at',
  'updated_at',
].join(', ');

const listStmt = db.prepare(`SELECT ${columns} FROM projects ORDER BY updated_at DESC`);
const getStmt = db.prepare(`SELECT ${columns} FROM projects WHERE project_id = ?`);
const upsertStmt = db.prepare(`
  INSERT INTO projects (
    project_id,
    name,
    description,
    repo_path,
    created_at,
    updated_at
  ) VALUES (
    @project_id,
    @name,
    @description,
    @repo_path,
    @created_at,
    @updated_at
  )
  ON CONFLICT(project_id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    repo_path = excluded.repo_path,
    updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare('DELETE FROM projects WHERE project_id = ?');

function rowToProject(row: ProjectRow): Project {
  return {
    project_id: row.project_id,
    name: row.name,
    description: row.description ?? undefined,
    repo_path: row.repo_path,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function projectToParams(project: Project): ProjectRow {
  return {
    project_id: project.project_id,
    name: project.name,
    description: project.description ?? null,
    repo_path: project.repo_path,
    created_at: project.created_at,
    updated_at: project.updated_at,
  };
}

export function listProjects(): Project[] {
  const rows = listStmt.all() as ProjectRow[];
  return rows.map(rowToProject);
}

export function getProject(projectId: string): Project | undefined {
  const row = getStmt.get(projectId) as ProjectRow | undefined;
  return row ? rowToProject(row) : undefined;
}

export function saveProject(project: Project): void {
  upsertStmt.run(projectToParams(project));
}

export function deleteProject(projectId: string): boolean {
  const result = deleteStmt.run(projectId);
  return result.changes > 0;
}
