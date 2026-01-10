/**
 * @supervisor/tool-runtime
 * Unified tool layer for Shell, Git, FS, and system operations
 */

// Types
export type {
  ShellPolicy,
  FilesystemPolicy,
  PolicyConfig,
  CommandResult,
  PolicyCheckResult,
  FileInfo,
  GitStatus,
  GitCommitInfo,
} from './types.js';

// Shell
export {
  ShellExecutor,
  createShellExecutor,
  type ShellExecutorOptions,
  type ExecuteOptions,
} from './shell.js';

// Git
export {
  GitTool,
  createGitTool,
  type GitToolOptions,
} from './git.js';

// Filesystem
export {
  FilesystemTool,
  createFilesystemTool,
  type FilesystemToolOptions,
} from './filesystem.js';

// Policy
export {
  checkShellPolicy,
  checkFilesystemWritePolicy,
  loadPolicyFromConfig,
} from './policy-checker.js';

// Desktop Control
export {
  DesktopControl,
  createDesktopControl,
  type ScreenshotResult,
  type ScreenSize,
  type ClickOptions,
  type KeyOptions,
} from './desktop.js';
