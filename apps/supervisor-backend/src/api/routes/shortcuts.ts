/**
 * Shortcuts API routes
 * Manage and execute saved command shortcuts
 */

import { Hono } from 'hono';
import { z } from 'zod';

const shortcuts = new Hono();

// In-memory storage for shortcuts (would be file-based in production)
const shortcutStore = new Map<string, Shortcut>();

interface Shortcut {
  id: string;
  name: string;
  description?: string;
  command: string;
  category?: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
}

const ShortcutSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  command: z.string().min(1),
  category: z.string().max(50).optional(),
  icon: z.string().max(50).optional(),
});

// Initialize with some default shortcuts
function initDefaults() {
  const defaults: Omit<Shortcut, 'id' | 'createdAt' | 'updatedAt'>[] = [
    {
      name: 'Build Project',
      command: 'npm run build',
      category: 'build',
      icon: 'hammer',
    },
    {
      name: 'Run Tests',
      command: 'npm test',
      category: 'test',
      icon: 'flask',
    },
    {
      name: 'Lint Code',
      command: 'npm run lint',
      category: 'lint',
      icon: 'check',
    },
    {
      name: 'Git Status',
      command: 'git status',
      category: 'git',
      icon: 'git-branch',
    },
    {
      name: 'Git Diff',
      command: 'git diff',
      category: 'git',
      icon: 'git-compare',
    },
  ];

  const now = new Date().toISOString();
  defaults.forEach((shortcut, index) => {
    const id = `default-${index + 1}`;
    shortcutStore.set(id, {
      ...shortcut,
      id,
      createdAt: now,
      updatedAt: now,
    });
  });
}

initDefaults();

/**
 * GET /api/shortcuts
 * List all shortcuts
 */
shortcuts.get('/', (c) => {
  const category = c.req.query('category');
  let result = Array.from(shortcutStore.values());

  if (category) {
    result = result.filter(s => s.category === category);
  }

  return c.json({
    shortcuts: result,
    total: result.length,
  });
});

/**
 * POST /api/shortcuts
 * Create a new shortcut
 */
shortcuts.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = ShortcutSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({
        error: {
          message: 'Invalid shortcut data',
          details: parsed.error.errors,
        },
      }, 400);
    }

    const now = new Date().toISOString();
    const id = `shortcut-${Date.now()}`;
    const shortcut: Shortcut = {
      ...parsed.data,
      id,
      createdAt: now,
      updatedAt: now,
    };

    shortcutStore.set(id, shortcut);

    return c.json(shortcut, 201);
  } catch (error) {
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to create shortcut',
      },
    }, 500);
  }
});

/**
 * GET /api/shortcuts/:id
 * Get a specific shortcut
 */
shortcuts.get('/:id', (c) => {
  const id = c.req.param('id');
  const shortcut = shortcutStore.get(id);

  if (!shortcut) {
    return c.json({
      error: { message: 'Shortcut not found' },
    }, 404);
  }

  return c.json(shortcut);
});

/**
 * PUT /api/shortcuts/:id
 * Update a shortcut
 */
shortcuts.put('/:id', async (c) => {
  const id = c.req.param('id');
  const existing = shortcutStore.get(id);

  if (!existing) {
    return c.json({
      error: { message: 'Shortcut not found' },
    }, 404);
  }

  try {
    const body = await c.req.json();
    const parsed = ShortcutSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({
        error: {
          message: 'Invalid shortcut data',
          details: parsed.error.errors,
        },
      }, 400);
    }

    const updated: Shortcut = {
      ...existing,
      ...parsed.data,
      updatedAt: new Date().toISOString(),
    };

    shortcutStore.set(id, updated);

    return c.json(updated);
  } catch (error) {
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to update shortcut',
      },
    }, 500);
  }
});

/**
 * DELETE /api/shortcuts/:id
 * Delete a shortcut
 */
shortcuts.delete('/:id', (c) => {
  const id = c.req.param('id');

  if (!shortcutStore.has(id)) {
    return c.json({
      error: { message: 'Shortcut not found' },
    }, 404);
  }

  shortcutStore.delete(id);

  return c.json({ message: 'Shortcut deleted' });
});

/**
 * POST /api/shortcuts/:id/execute
 * Execute a shortcut
 */
shortcuts.post('/:id/execute', async (c) => {
  const id = c.req.param('id');
  const shortcut = shortcutStore.get(id);

  if (!shortcut) {
    return c.json({
      error: { message: 'Shortcut not found' },
    }, 404);
  }

  // Get working directory from query or body
  const cwd = c.req.query('cwd') ?? process.cwd();

  try {
    const { createShellExecutor } = await import('@supervisor/tool-runtime');

    const shell = createShellExecutor(cwd);
    const result = await shell.execute(shortcut.command);

    return c.json({
      shortcut: shortcut.name,
      command: shortcut.command,
      result: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      },
    });
  } catch (error) {
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to execute shortcut',
      },
    }, 500);
  }
});

export { shortcuts };
