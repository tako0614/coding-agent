/**
 * File operations API routes
 * Exposes FilesystemTool functionality via REST API
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createFilesystemTool, loadPolicyFromConfig } from '@supervisor/tool-runtime';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateRepoPath, PathSecurityError } from '../../services/path-sandbox.js';
import { logger } from '../../services/logger.js';

const files = new Hono();

/** Maximum base64 content size (50MB decoded) */
const MAX_BASE64_DECODED_SIZE = 50 * 1024 * 1024;

/** Regex to validate base64 format */
const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Validate and decode base64 content
 * @returns Decoded buffer or error object
 */
function validateAndDecodeBase64(content: string): { valid: true; data: Buffer } | { valid: false; error: string } {
  // Check format (basic validation)
  if (!BASE64_REGEX.test(content)) {
    return { valid: false, error: 'Invalid base64 format' };
  }

  // Estimate decoded size (base64 is ~4/3 of original size)
  const estimatedSize = Math.ceil(content.length * 3 / 4);
  if (estimatedSize > MAX_BASE64_DECODED_SIZE) {
    return { valid: false, error: `Base64 content too large. Maximum decoded size is ${MAX_BASE64_DECODED_SIZE / 1024 / 1024}MB` };
  }

  try {
    const buffer = Buffer.from(content, 'base64');
    // Verify actual size
    if (buffer.length > MAX_BASE64_DECODED_SIZE) {
      return { valid: false, error: `Decoded content too large. Maximum size is ${MAX_BASE64_DECODED_SIZE / 1024 / 1024}MB` };
    }
    return { valid: true, data: buffer };
  } catch (err) {
    return { valid: false, error: 'Failed to decode base64 content' };
  }
}

// Default policy fallback
const DEFAULT_POLICY = {
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

// Cached policy - loaded once at startup
let cachedPolicy: ReturnType<typeof loadPolicyFromConfig> | null = null;

// Load policy from config (cached)
async function loadPolicy() {
  if (cachedPolicy) {
    return cachedPolicy;
  }

  try {
    const configPath = path.resolve(process.cwd(), '../../configs/policy/default.json');
    const content = await fs.readFile(configPath, 'utf-8');
    cachedPolicy = loadPolicyFromConfig(JSON.parse(content));
    return cachedPolicy;
  } catch {
    cachedPolicy = DEFAULT_POLICY;
    return cachedPolicy;
  }
}

/** Reload policy from config file (for hot-reload scenarios) */
export function reloadPolicy(): void {
  cachedPolicy = null;
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
 * Validate and get the working directory
 * If cwd is provided, validates it. Otherwise uses process.cwd()
 */
function getValidatedWorkingDir(cwd: string | undefined): { valid: true; dir: string } | { valid: false; error: string } {
  if (!cwd) {
    return { valid: true, dir: process.cwd() };
  }
  try {
    const validated = validateRepoPath(cwd);
    return { valid: true, dir: validated };
  } catch (err) {
    if (err instanceof PathSecurityError) {
      return { valid: false, error: err.message };
    }
    return { valid: false, error: 'Invalid working directory' };
  }
}

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
    const cwdResult = getValidatedWorkingDir(cwd);
    if (!cwdResult.valid) {
      return c.json({ error: { message: cwdResult.error, code: 'INVALID_CWD' } }, 400);
    }
    const workingDir = cwdResult.dir;
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
    // Use error.code for reliable error detection instead of string matching
    const isNotFound = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
    const code = isNotFound ? 'NOT_FOUND' : 'READ_ERROR';
    return c.json({ error: { message, code } }, isNotFound ? 404 : 500);
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
    const cwdResult = getValidatedWorkingDir(cwd);
    if (!cwdResult.valid) {
      return c.json({ error: { message: cwdResult.error, code: 'INVALID_CWD' } }, 400);
    }
    const workingDir = cwdResult.dir;
    const policy = await loadPolicy();
    const fsTool = createFilesystemTool(workingDir, policy.filesystem);

    // Validate and decode base64 if needed
    let data: string | Buffer;
    if (encoding === 'base64') {
      const base64Result = validateAndDecodeBase64(content);
      if (!base64Result.valid) {
        return c.json({ error: { message: base64Result.error, code: 'INVALID_BASE64' } }, 400);
      }
      data = base64Result.data;
    } else {
      data = content;
    }

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
    const cwdResult = getValidatedWorkingDir(cwd);
    if (!cwdResult.valid) {
      return c.json({ error: { message: cwdResult.error, code: 'INVALID_CWD' } }, 400);
    }
    const workingDir = cwdResult.dir;
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
    const cwdResult = getValidatedWorkingDir(cwd);
    if (!cwdResult.valid) {
      return c.json({ error: { message: cwdResult.error, code: 'INVALID_CWD' } }, 400);
    }
    const workingDir = cwdResult.dir;
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
    const cwdResult = getValidatedWorkingDir(cwd);
    if (!cwdResult.valid) {
      return c.json({ error: { message: cwdResult.error, code: 'INVALID_CWD' } }, 400);
    }
    const workingDir = cwdResult.dir;
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
    const cwdResult = getValidatedWorkingDir(cwd);
    if (!cwdResult.valid) {
      return c.json({ error: { message: cwdResult.error, code: 'INVALID_CWD' } }, 400);
    }
    const workingDir = cwdResult.dir;
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
    const cwdResult = getValidatedWorkingDir(cwd);
    if (!cwdResult.valid) {
      return c.json({ error: { message: cwdResult.error, code: 'INVALID_CWD' } }, 400);
    }
    const workingDir = cwdResult.dir;
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
    const cwdResult = getValidatedWorkingDir(cwd);
    if (!cwdResult.valid) {
      return c.json({ error: { message: cwdResult.error, code: 'INVALID_CWD' } }, 400);
    }
    const workingDir = cwdResult.dir;
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
    const cwdResult = getValidatedWorkingDir(cwd);
    if (!cwdResult.valid) {
      return c.json({ error: { message: cwdResult.error, code: 'INVALID_CWD' } }, 400);
    }
    const workingDir = cwdResult.dir;
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

// Schema for browse endpoint
const BrowseSchema = z.object({
  path: z.string().optional(),
});

/**
 * POST /api/files/browse
 * Browse directories for folder selection
 * Returns drives on Windows or root on Unix when no path specified
 */
files.post('/browse', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = BrowseSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: { message: 'Invalid request', details: parsed.error.errors } }, 400);
    }

    const requestedPath = parsed.data.path;

    // If no path specified, return root directories
    if (!requestedPath) {
      const isWindows = process.platform === 'win32';

      if (isWindows) {
        // Get available drives on Windows
        const { execSync } = await import('node:child_process');
        try {
          const output = execSync('wmic logicaldisk get name', { encoding: 'utf-8' });
          const drives = output
            .split('\n')
            .map(line => line.trim())
            .filter(line => /^[A-Z]:$/i.test(line))
            .map(drive => ({
              name: drive,
              path: drive + '\\',
              isDirectory: true,
              isDrive: true,
            }));

          return c.json({
            path: '',
            entries: drives,
            isRoot: true,
          });
        } catch {
          // Fallback: common drives
          const commonDrives = ['C:', 'D:', 'E:'].map(drive => ({
            name: drive,
            path: drive + '\\',
            isDirectory: true,
            isDrive: true,
          }));
          return c.json({
            path: '',
            entries: commonDrives,
            isRoot: true,
          });
        }
      } else {
        // Unix: return root and home
        const os = await import('node:os');
        const homedir = os.homedir();
        return c.json({
          path: '',
          entries: [
            { name: '/', path: '/', isDirectory: true, isDrive: false },
            { name: 'Home', path: homedir, isDirectory: true, isDrive: false },
          ],
          isRoot: true,
        });
      }
    }

    // Browse specific directory
    const normalizedPath = path.resolve(requestedPath);

    // Security check - don't allow path traversal
    if (requestedPath.includes('..')) {
      return c.json({ error: { message: 'Path traversal not allowed', code: 'SECURITY_ERROR' } }, 400);
    }

    try {
      const entries = await fs.readdir(normalizedPath, { withFileTypes: true });

      // Filter to directories only and sort
      const directories = entries
        .filter(entry => {
          try {
            return entry.isDirectory();
          } catch {
            return false;
          }
        })
        .map(entry => ({
          name: entry.name,
          path: path.join(normalizedPath, entry.name),
          isDirectory: true,
          isDrive: false,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      // Get parent directory
      const parentPath = path.dirname(normalizedPath);
      const isAtRoot = process.platform === 'win32'
        ? /^[A-Z]:\\?$/i.test(normalizedPath)
        : normalizedPath === '/';

      return c.json({
        path: normalizedPath,
        entries: directories,
        parent: isAtRoot ? null : parentPath,
        isRoot: false,
      });
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return c.json({ error: { message: 'Directory not found', code: 'NOT_FOUND' } }, 404);
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return c.json({ error: { message: 'Permission denied', code: 'PERMISSION_DENIED' } }, 403);
      }
      throw err;
    }
  } catch (error) {
    logger.error('Browse directory error', { error: error instanceof Error ? error.message : String(error) });
    return c.json({
      error: { message: error instanceof Error ? error.message : 'Failed to browse directory' },
    }, 500);
  }
});

export { files };
