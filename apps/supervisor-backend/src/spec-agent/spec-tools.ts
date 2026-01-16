/**
 * Spec Agent Tools
 * Limited tool set for specification mode (no run_command, no spawn_workers)
 */

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { logger } from '../services/logger.js';
import { getErrorMessage } from '../services/errors.js';
import { validatePath, PathSecurityError } from '../services/path-sandbox.js';

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      items?: { type: string };
    }>;
    required: string[];
  };
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Tool definitions for Anthropic API
 */
export const SPEC_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Use this to reference existing code or specifications.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The file path relative to the repository root',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description: 'Create or edit a file. Use this to write specifications. If the file exists, replaces content. If not, creates it.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The file path relative to the repository root',
        },
        content: {
          type: 'string',
          description: 'The complete content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and directories in a path. Use this to explore the project structure.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The directory path relative to the repository root. Use "." for root.',
        },
        recursive: {
          type: 'boolean',
          description: 'If true, list files recursively (max depth 3)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'complete',
    description: 'Signal that the specification task is complete. Call this when you have finished drafting the specification and the user is satisfied.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'A brief summary of what was accomplished',
        },
        files_created: {
          type: 'array',
          description: 'List of specification files created or modified',
          items: { type: 'string' },
        },
      },
      required: ['summary'],
    },
  },
];

/**
 * Validate path to prevent directory traversal
 * Uses the shared path-sandbox for security
 */
async function validateFilePath(repoPath: string, filePath: string, allowCreate = false): Promise<string> {
  try {
    return await validatePath(repoPath, filePath, {
      allowCreate,
      followSymlinks: true,
    });
  } catch (err) {
    if (err instanceof PathSecurityError) {
      throw new Error(`Security: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Execute a spec tool
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  repoPath: string
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'read_file':
        return await executeReadFile(input, repoPath);
      case 'edit_file':
        return await executeEditFile(input, repoPath);
      case 'list_files':
        return await executeListFiles(input, repoPath);
      case 'complete':
        return executeComplete(input);
      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    logger.error('Tool execution failed', { toolName, error: errorMsg });
    return { success: false, error: errorMsg };
  }
}

async function executeReadFile(
  input: Record<string, unknown>,
  repoPath: string
): Promise<ToolResult> {
  const filePath = input['path'] as string;
  if (!filePath) {
    return { success: false, error: 'Missing required parameter: path' };
  }

  let fullPath: string;
  try {
    fullPath = await validateFilePath(repoPath, filePath, false);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Invalid path' };
  }

  if (!existsSync(fullPath)) {
    return { success: false, error: `File not found: ${filePath}` };
  }

  const stats = await stat(fullPath);
  if (!stats.isFile()) {
    return { success: false, error: `Not a file: ${filePath}` };
  }

  // Limit file size (1MB)
  if (stats.size > 1024 * 1024) {
    return { success: false, error: `File too large: ${filePath} (max 1MB)` };
  }

  const content = await readFile(fullPath, 'utf-8');
  return { success: true, output: content };
}

async function executeEditFile(
  input: Record<string, unknown>,
  repoPath: string
): Promise<ToolResult> {
  const filePath = input['path'] as string;
  const content = input['content'] as string;

  if (!filePath) {
    return { success: false, error: 'Missing required parameter: path' };
  }
  if (content === undefined) {
    return { success: false, error: 'Missing required parameter: content' };
  }

  let fullPath: string;
  try {
    fullPath = await validateFilePath(repoPath, filePath, true); // allowCreate = true
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Invalid path' };
  }

  // Create directory if needed
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(fullPath, content, 'utf-8');
  return {
    success: true,
    output: `Successfully wrote ${content.length} characters to ${filePath}`,
  };
}

async function executeListFiles(
  input: Record<string, unknown>,
  repoPath: string
): Promise<ToolResult> {
  const dirPath = (input['path'] as string) || '.';
  const recursive = input['recursive'] as boolean;

  let fullPath: string;
  try {
    fullPath = await validateFilePath(repoPath, dirPath, false);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Invalid path' };
  }

  if (!existsSync(fullPath)) {
    return { success: false, error: `Directory not found: ${dirPath}` };
  }

  const stats = await stat(fullPath);
  if (!stats.isDirectory()) {
    return { success: false, error: `Not a directory: ${dirPath}` };
  }

  const entries: string[] = [];

  async function listDir(path: string, depth: number): Promise<void> {
    if (depth > 3) return; // Max depth

    const items = await readdir(path, { withFileTypes: true });
    for (const item of items) {
      // Skip hidden files and node_modules
      if (item.name.startsWith('.') || item.name === 'node_modules') {
        continue;
      }

      const itemPath = join(path, item.name);
      const relativePath = relative(repoPath, itemPath);

      if (item.isDirectory()) {
        entries.push(`${relativePath}/`);
        if (recursive) {
          await listDir(itemPath, depth + 1);
        }
      } else {
        entries.push(relativePath);
      }
    }
  }

  await listDir(fullPath, 0);

  // Sort and limit entries
  entries.sort();
  const limited = entries.slice(0, 500);
  const output = limited.join('\n');

  if (entries.length > 500) {
    return {
      success: true,
      output: `${output}\n\n... and ${entries.length - 500} more items`,
    };
  }

  return { success: true, output: output || '(empty directory)' };
}

function executeComplete(input: Record<string, unknown>): ToolResult {
  const summary = input['summary'] as string;
  const filesCreated = input['files_created'] as string[] | undefined;

  if (!summary) {
    return { success: false, error: 'Missing required parameter: summary' };
  }

  let output = `Specification complete: ${summary}`;
  if (filesCreated && filesCreated.length > 0) {
    // Build string directly instead of map().join() to avoid intermediate array
    output += '\n\nFiles created/modified:';
    for (const f of filesCreated) {
      output += `\n- ${f}`;
    }
  }

  return { success: true, output };
}
