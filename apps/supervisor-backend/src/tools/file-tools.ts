/**
 * File operation tools for agents
 * Provides read, write, list, and edit capabilities for repository files
 */

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';

export interface FileInfo {
  name: string;
  path: string;
  relativePath: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: string;
}

export interface FileToolsOptions {
  repoPath: string;
}

/**
 * File tools for repository operations
 */
export class FileTools {
  private repoPath: string;

  constructor(options: FileToolsOptions) {
    this.repoPath = options.repoPath;
  }

  /**
   * List files in a directory
   */
  async listFiles(dirPath: string = ''): Promise<FileInfo[]> {
    const fullPath = join(this.repoPath, dirPath);
    const entries = await readdir(fullPath, { withFileTypes: true });

    const files: FileInfo[] = [];
    for (const entry of entries) {
      // Skip hidden files and common ignore patterns
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }

      const entryPath = join(fullPath, entry.name);
      const relativePath = relative(this.repoPath, entryPath);

      try {
        const stats = await stat(entryPath);
        files.push({
          name: entry.name,
          path: entryPath,
          relativePath,
          isDirectory: entry.isDirectory(),
          size: entry.isFile() ? stats.size : undefined,
          modifiedAt: stats.mtime.toISOString(),
        });
      } catch {
        // Skip files we can't stat
      }
    }

    return files.sort((a, b) => {
      // Directories first, then files
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * List files recursively (with depth limit)
   */
  async listFilesRecursive(dirPath: string = '', maxDepth: number = 3): Promise<FileInfo[]> {
    const result: FileInfo[] = [];

    const traverse = async (currentPath: string, depth: number) => {
      if (depth > maxDepth) return;

      const files = await this.listFiles(currentPath);
      for (const file of files) {
        result.push(file);
        if (file.isDirectory) {
          await traverse(file.relativePath, depth + 1);
        }
      }
    };

    await traverse(dirPath, 0);
    return result;
  }

  /**
   * Read a file's contents
   */
  async readFile(filePath: string): Promise<string> {
    const fullPath = join(this.repoPath, filePath);
    return await readFile(fullPath, 'utf-8');
  }

  /**
   * Write content to a file (creates directories if needed)
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    const fullPath = join(this.repoPath, filePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
  }

  /**
   * Check if a file exists
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      await stat(join(this.repoPath, filePath));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file info
   */
  async getFileInfo(filePath: string): Promise<FileInfo | null> {
    try {
      const fullPath = join(this.repoPath, filePath);
      const stats = await stat(fullPath);
      return {
        name: filePath.split('/').pop() ?? filePath,
        path: fullPath,
        relativePath: filePath,
        isDirectory: stats.isDirectory(),
        size: stats.isFile() ? stats.size : undefined,
        modifiedAt: stats.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Edit a file by applying a transformation function
   */
  async editFile(
    filePath: string,
    transformer: (content: string) => string
  ): Promise<{ before: string; after: string }> {
    const before = await this.readFile(filePath);
    const after = transformer(before);
    await this.writeFile(filePath, after);
    return { before, after };
  }

  /**
   * Replace text in a file
   */
  async replaceInFile(
    filePath: string,
    searchPattern: string | RegExp,
    replacement: string
  ): Promise<{ count: number }> {
    const content = await this.readFile(filePath);
    const regex = typeof searchPattern === 'string'
      ? new RegExp(searchPattern, 'g')
      : searchPattern;

    let count = 0;
    const newContent = content.replace(regex, () => {
      count++;
      return replacement;
    });

    if (count > 0) {
      await this.writeFile(filePath, newContent);
    }

    return { count };
  }

  /**
   * Append content to a file
   */
  async appendToFile(filePath: string, content: string): Promise<void> {
    const existing = await this.exists(filePath)
      ? await this.readFile(filePath)
      : '';
    await this.writeFile(filePath, existing + content);
  }

  /**
   * Search for files by pattern
   */
  async findFiles(pattern: RegExp, dirPath: string = ''): Promise<FileInfo[]> {
    const allFiles = await this.listFilesRecursive(dirPath);
    return allFiles.filter(f => !f.isDirectory && pattern.test(f.relativePath));
  }

  /**
   * Search for content in files
   */
  async searchInFiles(
    searchPattern: string | RegExp,
    dirPath: string = ''
  ): Promise<Array<{ file: FileInfo; matches: string[] }>> {
    const files = await this.listFilesRecursive(dirPath);
    const results: Array<{ file: FileInfo; matches: string[] }> = [];

    const regex = typeof searchPattern === 'string'
      ? new RegExp(searchPattern, 'g')
      : searchPattern;

    for (const file of files) {
      if (file.isDirectory) continue;

      try {
        const content = await this.readFile(file.relativePath);
        const matches = content.match(regex);
        if (matches && matches.length > 0) {
          results.push({ file, matches });
        }
      } catch {
        // Skip files we can't read
      }
    }

    return results;
  }
}

/**
 * Create a FileTools instance for a repository
 */
export function createFileTools(repoPath: string): FileTools {
  return new FileTools({ repoPath });
}
