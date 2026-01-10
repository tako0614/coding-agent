/**
 * Types for tool-runtime
 */

export interface ShellPolicy {
  allowlist: string[];
  denylist: string[];
  argumentPatterns: Record<string, {
    forbiddenFlags?: string[];
    requireConfirmation?: string[];
  }>;
  maxExecutionTimeMs: number;
  maxOutputSizeBytes: number;
}

export interface FilesystemPolicy {
  writeRoots: string[];
  forbiddenPaths: string[];
  maxFileSizeBytes: number;
}

export interface PolicyConfig {
  shell: ShellPolicy;
  filesystem: FilesystemPolicy;
}

export interface CommandResult {
  cmd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  killed: boolean;
  timedOut: boolean;
}

export interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
  requiresConfirmation?: boolean;
  confirmationReason?: string;
}

export interface FileInfo {
  path: string;
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  modifiedAt: Date;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  deleted: string[];
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: Date;
  message: string;
}
