/**
 * File operations API routes
 * Exposes FilesystemTool functionality via REST API
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createFilesystemTool, loadPolicyFromConfig } from '@supervisor/tool-runtime';
import fs from 'node:fs/promises';
import path from 'node:path';

const files = new Hono();

// Load policy from config
async function loadPolicy() {
  try {
    const configPath = path.resolve(process.cwd(), '../../configs/policy/default.json');
    const content = await fs.readFile(configPath, 'utf-8');
    return loadPolicyFromConfig(JSON.parse(content));
  } catch {
    return {
      shell: {
        allowlist: [],
        denylist: [],
        argumentPatterns: {},
        maxExecutionTimeMs: 300000,
        maxOutputSizeBytes: 10485760,
      },
      filesystem: {
        writeRoots: ['./'],
        forbiddenPaths: [],
        maxFileSizeBytes: 52428800,
      },
    };
  }
}

// Schemas
const ReadFileSchema = z.object({
  path: z.string().min(1),
  cwd: z.string().optional(),
  encoding: z.enum(['utf-8', 'base64']).optional().default('utf-8'),
});

const WriteFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  cwd: z.string().optional(),
  encoding: z.enum(['utf-8', 'base64']).optional().default('utf-8'),
});

const ListDirSchema = z.object({
  path: z.string().optional().default('.'),
  cwd: z.string().optional(),
  recursive: z.boolean().optional().default(false),
});

const GlobSchema = z.object({
  pattern: z.string().min(1),
  cwd: z.string().optional(),
  ignore: z.array(z.string()).optional(),
});

const DeleteSchema = z.object({
  path: z.string().min(1),
  cwd: z.string().optional(),
});

const MkdirSchema = z.object({
  path: z.string().min(1),
  cwd: z.string().optional(),
});

const CopyMoveSchema = z.object({
  source: z.string().min(1),
  destination: z.string().min(1),
  cwd: z.string().optional(),
});

const StatSchema = z.object({
  path: z.string().min(1),
  cwd: z.string().optional(),
});

/**
 * POST /api/files/read
 * Read a file
 */
files.post('/read', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = ReadFileSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: { message: 'Invalid request', details: parsed.error.errors } }, 400);
    }

    const { path: filePath, cwd, encoding } = parsed.data;
    const workingDir = cwd || process.cwd();
    const policy = await loadPolicy();
    const fsTool = createFilesystemTool(workingDir, policy.filesystem);

    if (encoding === 'base64') {
      const buffer = await fsTool.readFileBuffer(filePath);
      return c.json({
        path: filePath,
        content: buffer.toString('base64'),
        encoding: 'base64',
        size: buffer.length,
      });
    } else {
      const content = await fsTool.readFile(filePath);
      return c.json({
        path: filePath,
        content,
        encoding: 'utf-8',
        size: Buffer.byteLength(content),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read file';
    const code = message.includes('ENOENT') ? 'NOT_FOUND' : 'READ_ERROR';
    return c.json({ error: { message, code } }, code === 'NOT_FOUND' ? 404 : 500);
  }
});

/**
 * POST /api/files/write
 * Write a file (policy-checked)
 */
files.post('/write', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = WriteFileSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: { message: 'Invalid request', details: parsed.error.errors } }, 400);
    }

    const { path: filePath, content, cwd, encoding } = parsed.data;
    const workingDir = cwd || process.cwd();
    const policy = await loadPolicy();
    const fsTool = createFilesystemTool(workingDir, policy.filesystem);

    const data = encoding === 'base64' ? Buffer.from(content, 'base64') : content;
    const result = await fsTool.writeFile(filePath, data);

    if (!result.allowed) {
      return c.json({ error: { message: result.reason, code: 'POLICY_VIOLATION' } }, 403);
    }

    return c.json({
      path: filePath,
      success: true,
      size: typeof data === 'string' ? Buffer.byteLength(data) : data.length,
    });
  } catch (error) {
    return c.json({
      error: { message: error instanceof Error ? error.message : 'Failed to write file' },
    }, 500);
  }
});

/**
 * POST /api/files/list
 * List directory contents
 */
files.post('/list', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = ListDirSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: { message: 'Invalid request', details: parsed.error.errors } }, 400);
    }

    const { path: dirPath, cwd, recursive } = parsed.data;
    const workingDir = cwd || process.cwd();
    const policy = await loadPolicy();
    const fsTool = createFilesystemTool(workingDir, policy.filesystem);

    if (recursive) {
      // Use glob for recursive listing
      const files = await fsTool.glob(`${dirPath}/**/*`);
      return c.json({ path: dirPath, entries: files, recursive: true });
    }

    const entries = await fsTool.readdir(dirPath);

    // Get detailed info for each entry
    const detailed = await Promise.all(
      entries.map(async (name) => {
        const entryPath = path.join(dirPath, name);
        const info = await fsTool.stat(entryPath);
        return {
          name,
          path: entryPath,
          isFile: info.isFile,
          isDirectory: info.isDirectory,
          size: info.size,
          modifiedAt: info.modifiedAt,
        };
      })
    );

    return c.json({ path: dirPath, entries: detailed, recursive: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list directory';
    return c.json({ error: { message } }, 500);
  }
});

/**
 * POST /api/files/glob
 * Find files matching a pattern
 */
files.post('/glob', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = GlobSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: { message: 'Invalid request', details: parsed.error.errors } }, 400);
    }

    const { pattern, cwd, ignore } = parsed.data;
    const workingDir = cwd || process.cwd();
    const policy = await loadPolicy();
    const fsTool = createFilesystemTool(workingDir, policy.filesystem);

    const matches = await fsTool.glob(pattern, { ignore });

    return c.json({ pattern, matches, count: matches.length });
  } catch (error) {
    return c.json({
      error: { message: error instanceof Error ? error.message : 'Failed to glob' },
    }, 500);
  }
});

/**
 * POST /api/files/stat
 * Get file/directory info
 */
files.post('/stat', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = StatSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: { message: 'Invalid request', details: parsed.error.errors } }, 400);
    }

    const { path: targetPath, cwd } = parsed.data;
    const workingDir = cwd || process.cwd();
    const policy = await loadPolicy();
    const fsTool = createFilesystemTool(workingDir, policy.filesystem);

    const info = await fsTool.stat(targetPath);

    return c.json(info);
  } catch (error) {
    return c.json({
      error: { message: error instanceof Error ? error.message : 'Failed to stat' },
    }, 500);
  }
});

/**
 * POST /api/files/delete
 * Delete a file (policy-checked)
 */
files.post('/delete', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = DeleteSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: { message: 'Invalid request', details: parsed.error.errors } }, 400);
    }

    const { path: filePath, cwd } = parsed.data;
    const workingDir = cwd || process.cwd();
    const policy = await loadPolicy();
    const fsTool = createFilesystemTool(workingDir, policy.filesystem);

    const result = await fsTool.deleteFile(filePath);

    if (!result.allowed) {
      return c.json({ error: { message: result.reason, code: 'POLICY_VIOLATION' } }, 403);
    }

    return c.json({ path: filePath, deleted: true });
  } catch (error) {
    return c.json({
      error: { message: error instanceof Error ? error.message : 'Failed to delete file' },
    }, 500);
  }
});

/**
 * POST /api/files/mkdir
 * Create a directory (policy-checked)
 */
files.post('/mkdir', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = MkdirSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: { message: 'Invalid request', details: parsed.error.errors } }, 400);
    }

    const { path: dirPath, cwd } = parsed.data;
    const workingDir = cwd || process.cwd();
    const policy = await loadPolicy();
    const fsTool = createFilesystemTool(workingDir, policy.filesystem);

    const result = await fsTool.mkdir(dirPath);

    if (!result.allowed) {
      return c.json({ error: { message: result.reason, code: 'POLICY_VIOLATION' } }, 403);
    }

    return c.json({ path: dirPath, created: true });
  } catch (error) {
    return c.json({
      error: { message: error instanceof Error ? error.message : 'Failed to create directory' },
    }, 500);
  }
});

/**
 * POST /api/files/copy
 * Copy a file (policy-checked for destination)
 */
files.post('/copy', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = CopyMoveSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: { message: 'Invalid request', details: parsed.error.errors } }, 400);
    }

    const { source, destination, cwd } = parsed.data;
    const workingDir = cwd || process.cwd();
    const policy = await loadPolicy();
    const fsTool = createFilesystemTool(workingDir, policy.filesystem);

    const result = await fsTool.copyFile(source, destination);

    if (!result.allowed) {
      return c.json({ error: { message: result.reason, code: 'POLICY_VIOLATION' } }, 403);
    }

    return c.json({ source, destination, copied: true });
  } catch (error) {
    return c.json({
      error: { message: error instanceof Error ? error.message : 'Failed to copy file' },
    }, 500);
  }
});

/**
 * POST /api/files/move
 * Move/rename a file (policy-checked)
 */
files.post('/move', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = CopyMoveSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: { message: 'Invalid request', details: parsed.error.errors } }, 400);
    }

    const { source, destination, cwd } = parsed.data;
    const workingDir = cwd || process.cwd();
    const policy = await loadPolicy();
    const fsTool = createFilesystemTool(workingDir, policy.filesystem);

    const result = await fsTool.moveFile(source, destination);

    if (!result.allowed) {
      return c.json({ error: { message: result.reason, code: 'POLICY_VIOLATION' } }, 403);
    }

    return c.json({ source, destination, moved: true });
  } catch (error) {
    return c.json({
      error: { message: error instanceof Error ? error.message : 'Failed to move file' },
    }, 500);
  }
});

export { files };
