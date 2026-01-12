/**
 * Read Context Node
 * Reads AGENTS.md from the repository to understand the project
 */

import { readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { ParallelSupervisorStateType } from '../parallel-state.js';
import { log as eventLog } from '../../services/event-bus.js';

// Files to look for (AGENTS.md only)
const CONTEXT_FILES = [
  'AGENTS.md',
];

// Project config files (for detecting project type)
const PROJECT_FILES = [
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'CMakeLists.txt',
  'Makefile',
];

interface RepoContext {
  // Agent instructions if found
  agentInstructions?: string;
  // Project specs if found
  specs?: string;
  // README/overview
  readme?: string;
  // Project type (node, rust, python, etc.)
  projectType?: string;
  // All found context concatenated
  fullContext: string;
  // List of files that were read
  filesRead: string[];
}

/**
 * Read a file safely, returning undefined if not found
 */
async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Check if a path exists
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect project type from config files
 */
async function detectProjectType(repoPath: string): Promise<string | undefined> {
  for (const file of PROJECT_FILES) {
    if (await exists(join(repoPath, file))) {
      switch (file) {
        case 'package.json':
          return 'node';
        case 'Cargo.toml':
          return 'rust';
        case 'pyproject.toml':
          return 'python';
        case 'go.mod':
          return 'go';
        case 'pom.xml':
        case 'build.gradle':
          return 'java';
        case 'CMakeLists.txt':
          return 'cpp';
        case 'Makefile':
          return 'make';
      }
    }
  }
  return undefined;
}

/**
 * Read repository context
 */
async function readRepoContext(repoPath: string): Promise<RepoContext> {
  const context: RepoContext = {
    fullContext: '',
    filesRead: [],
  };

  const sections: string[] = [];

  // Read context files
  for (const file of CONTEXT_FILES) {
    const filePath = join(repoPath, file);
    const content = await readFileSafe(filePath);

    if (content) {
      context.filesRead.push(file);

      // Categorize the content
      const fileName = basename(file).toLowerCase();
      if (fileName.includes('agent') || fileName.includes('claude') || fileName.includes('codex')) {
        context.agentInstructions = content;
        sections.push(`## Agent Instructions (${file})\n\n${content}`);
      } else if (fileName.includes('spec')) {
        context.specs = content;
        sections.push(`## Specifications (${file})\n\n${content}`);
      } else if (fileName.includes('readme')) {
        context.readme = content;
        sections.push(`## Project Overview (${file})\n\n${content}`);
      } else {
        sections.push(`## ${file}\n\n${content}`);
      }
    }
  }

  // Detect project type
  context.projectType = await detectProjectType(repoPath);
  if (context.projectType) {
    sections.unshift(`Project Type: ${context.projectType}`);
  }

  context.fullContext = sections.join('\n\n---\n\n');

  return context;
}

/**
 * Read context node - reads relevant files from the repository
 */
export async function readContextNode(
  state: ParallelSupervisorStateType
): Promise<Partial<ParallelSupervisorStateType>> {
  console.log('[ReadContext] Reading repository context...');
  eventLog(state.run_id, 'info', 'supervisor', '📖 Reading repository context...');

  const context = await readRepoContext(state.repo_path);

  console.log(`[ReadContext] Found ${context.filesRead.length} context files: ${context.filesRead.join(', ')}`);

  if (context.filesRead.length > 0) {
    eventLog(state.run_id, 'info', 'supervisor', `📄 Found: ${context.filesRead.join(', ')}`);
  } else {
    eventLog(state.run_id, 'warn', 'supervisor', '⚠️ No AGENTS.md or spec files found in repository');
  }

  if (context.projectType) {
    console.log(`[ReadContext] Detected project type: ${context.projectType}`);
    eventLog(state.run_id, 'debug', 'system', `Project type: ${context.projectType}`);
  }

  if (context.agentInstructions) {
    console.log('[ReadContext] Found agent instructions (AGENTS.md or similar)');
    eventLog(state.run_id, 'info', 'supervisor', '✓ Agent instructions found');
  }

  return {
    repo_context: context.fullContext,
    updated_at: new Date().toISOString(),
  };
}

export { readRepoContext, type RepoContext };
