/**
 * Project management API routes
 *
 * Project is simply a reference to a repository path.
 * Specs are managed as files within the repository itself.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { deleteProject, getProject, listProjects, saveProject } from '../../services/project-store.js';
import { logger } from '../../services/logger.js';

// Simplified project schema - just a reference to a repo
export interface Project {
  project_id: string;
  name: string;
  description?: string;
  repo_path: string;
  created_at: string;
  updated_at: string;
}

const CreateProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  repo_path: z.string().min(1),
});

const UpdateProjectSchema = CreateProjectSchema.partial();

const projects = new Hono();

/**
 * GET /api/projects
 * List all projects
 */
projects.get('/', (c) => {
  const allProjects = listProjects();

  return c.json({
    projects: allProjects,
    total: allProjects.length,
  });
});

/**
 * POST /api/projects
 * Create a new project
 */
projects.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = CreateProjectSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({
        error: {
          message: 'Invalid request body',
          details: parsed.error.errors,
        },
      }, 400);
    }

    const data = parsed.data;
    const now = new Date().toISOString();

    const project: Project = {
      project_id: `proj_${uuidv4().slice(0, 8)}`,
      name: data.name,
      description: data.description,
      repo_path: data.repo_path,
      created_at: now,
      updated_at: now,
    };

    saveProject(project);
    logger.info('Created project', { projectId: project.project_id, name: project.name });

    return c.json(project, 201);
  } catch (error) {
    logger.error('Error creating project', { error: error instanceof Error ? error.message : String(error) });
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Internal server error',
      },
    }, 500);
  }
});

/**
 * GET /api/projects/:id
 * Get a specific project
 */
projects.get('/:id', (c) => {
  const projectId = c.req.param('id');
  const project = getProject(projectId);

  if (!project) {
    return c.json({
      error: {
        message: `Project ${projectId} not found`,
      },
    }, 404);
  }

  return c.json(project);
});

/**
 * PUT /api/projects/:id
 * Update a project
 */
projects.put('/:id', async (c) => {
  try {
    const projectId = c.req.param('id');
    const existing = getProject(projectId);

    if (!existing) {
      return c.json({
        error: {
          message: `Project ${projectId} not found`,
        },
      }, 404);
    }

    const body = await c.req.json();
    const parsed = UpdateProjectSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({
        error: {
          message: 'Invalid request body',
          details: parsed.error.errors,
        },
      }, 400);
    }

    const data = parsed.data;
    const updated: Project = {
      ...existing,
      ...data,
      updated_at: new Date().toISOString(),
    };

    saveProject(updated);
    logger.info('Updated project', { projectId });

    return c.json(updated);
  } catch (error) {
    logger.error('Error updating project', { error: error instanceof Error ? error.message : String(error) });
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Internal server error',
      },
    }, 500);
  }
});

/**
 * DELETE /api/projects/:id
 * Delete a project
 */
projects.delete('/:id', (c) => {
  const projectId = c.req.param('id');

  const deleted = deleteProject(projectId);

  if (!deleted) {
    return c.json({
      error: {
        message: `Project ${projectId} not found`,
      },
    }, 404);
  }

  logger.info('Deleted project', { projectId });

  return c.json({ message: `Project ${projectId} deleted` });
});

export { getProject, listProjects };

export { projects };
