/**
 * Filesystem operations with policy enforcement
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import type { FileInfo, FilesystemPolicy, PolicyCheckResult } from './types.js';
import { checkFilesystemWritePolicy } from './policy-checker.js';

export interface FilesystemToolOptions {
  policy: FilesystemPolicy;
  cwd: string;
}

export class FilesystemTool {
  private policy: FilesystemPolicy;
  private cwd: string;

  constructor(options: FilesystemToolOptions) {
    this.policy = options.policy;
    this.cwd = options.cwd;
  }

  /**
   * Resolve a path relative to cwd
   */
  private resolvePath(targetPath: string): string {
    return path.isAbsolute(targetPath)
      ? targetPath
      : path.resolve(this.cwd, targetPath);
  }

  /**
   * Check if a write operation is allowed
   */
  checkWritePolicy(targetPath: string): PolicyCheckResult {
    return checkFilesystemWritePolicy(targetPath, this.policy, this.cwd);
  }

  /**
   * Read a file
   */
  async readFile(filePath: string): Promise<string> {
    const resolved = this.resolvePath(filePath);
    return fs.readFile(resolved, 'utf-8');
  }

  /**
   * Read a file as buffer
   */
  async readFileBuffer(filePath: string): Promise<Buffer> {
    const resolved = this.resolvePath(filePath);
    return fs.readFile(resolved);
  }

  /**
   * Write a file (policy-checked)
   */
  async writeFile(filePath: string, content: string | Buffer): Promise<PolicyCheckResult & { success?: boolean }> {
    const policyCheck = this.checkWritePolicy(filePath);
    if (!policyCheck.allowed) {
      return policyCheck;
    }

    // Check file size
    const size = typeof content === 'string' ? Buffer.byteLength(content) : content.length;
    if (size > this.policy.maxFileSizeBytes) {
      return {
        allowed: false,
        reason: `File size (${size} bytes) exceeds maximum allowed (${this.policy.maxFileSizeBytes} bytes)`,
      };
    }

    const resolved = this.resolvePath(filePath);

    // Ensure directory exists
    await fs.mkdir(path.dirname(resolved), { recursive: true });

    // Write the file
    await fs.writeFile(resolved, content);

    return { allowed: true, success: true };
  }

  /**
   * Delete a file (policy-checked)
   */
  async deleteFile(filePath: string): Promise<PolicyCheckResult & { success?: boolean }> {
    const policyCheck = this.checkWritePolicy(filePath);
    if (!policyCheck.allowed) {
      return policyCheck;
    }

    const resolved = this.resolvePath(filePath);
    await fs.unlink(resolved);

    return { allowed: true, success: true };
  }

  /**
   * Create a directory (policy-checked)
   */
  async mkdir(dirPath: string): Promise<PolicyCheckResult & { success?: boolean }> {
    const policyCheck = this.checkWritePolicy(dirPath);
    if (!policyCheck.allowed) {
      return policyCheck;
    }

    const resolved = this.resolvePath(dirPath);
    await fs.mkdir(resolved, { recursive: true });

    return { allowed: true, success: true };
  }

  /**
   * Get file/directory info
   */
  async stat(targetPath: string): Promise<FileInfo> {
    const resolved = this.resolvePath(targetPath);

    try {
      const stats = await fs.stat(resolved);
      return {
        path: resolved,
        exists: true,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modifiedAt: stats.mtime,
      };
    } catch {
      return {
        path: resolved,
        exists: false,
        isFile: false,
        isDirectory: false,
        size: 0,
        modifiedAt: new Date(0),
      };
    }
  }

  /**
   * Check if a path exists
   */
  async exists(targetPath: string): Promise<boolean> {
    const info = await this.stat(targetPath);
    return info.exists;
  }

  /**
   * List directory contents
   */
  async readdir(dirPath: string): Promise<string[]> {
    const resolved = this.resolvePath(dirPath);
    return fs.readdir(resolved);
  }

  /**
   * Find files matching a glob pattern
   */
  async glob(pattern: string, options: { ignore?: string[] } = {}): Promise<string[]> {
    return glob(pattern, {
      cwd: this.cwd,
      ignore: options.ignore,
      absolute: false,
    });
  }

  /**
   * Copy a file (policy-checked for destination)
   */
  async copyFile(source: string, destination: string): Promise<PolicyCheckResult & { success?: boolean }> {
    const policyCheck = this.checkWritePolicy(destination);
    if (!policyCheck.allowed) {
      return policyCheck;
    }

    const resolvedSrc = this.resolvePath(source);
    const resolvedDst = this.resolvePath(destination);

    // Ensure destination directory exists
    await fs.mkdir(path.dirname(resolvedDst), { recursive: true });

    await fs.copyFile(resolvedSrc, resolvedDst);

    return { allowed: true, success: true };
  }

  /**
   * Move/rename a file (policy-checked for both source and destination)
   */
  async moveFile(source: string, destination: string): Promise<PolicyCheckResult & { success?: boolean }> {
    // Check both source (delete) and destination (write)
    const sourceCheck = this.checkWritePolicy(source);
    if (!sourceCheck.allowed) {
      return { allowed: false, reason: `Cannot delete source: ${sourceCheck.reason}` };
    }

    const destCheck = this.checkWritePolicy(destination);
    if (!destCheck.allowed) {
      return { allowed: false, reason: `Cannot write to destination: ${destCheck.reason}` };
    }

    const resolvedSrc = this.resolvePath(source);
    const resolvedDst = this.resolvePath(destination);

    // Ensure destination directory exists
    await fs.mkdir(path.dirname(resolvedDst), { recursive: true });

    await fs.rename(resolvedSrc, resolvedDst);

    return { allowed: true, success: true };
  }

  /**
   * Set the current working directory
   */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /**
   * Get the current working directory
   */
  getCwd(): string {
    return this.cwd;
  }
}

/**
 * Create a filesystem tool with default policy
 */
export function createFilesystemTool(
  cwd: string,
  policy?: Partial<FilesystemPolicy>
): FilesystemTool {
  const defaultPolicy: FilesystemPolicy = {
    writeRoots: ['./'],
    forbiddenPaths: [],
    maxFileSizeBytes: 52428800,
  };

  return new FilesystemTool({
    policy: { ...defaultPolicy, ...policy },
    cwd,
  });
}
