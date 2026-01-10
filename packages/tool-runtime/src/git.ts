/**
 * Git operations wrapper
 */

import { simpleGit, type SimpleGit, type StatusResult, type LogResult } from 'simple-git';
import type { GitStatus, GitCommitInfo } from './types.js';

export interface GitToolOptions {
  baseDir: string;
}

export class GitTool {
  private git: SimpleGit;
  private baseDir: string;

  constructor(options: GitToolOptions) {
    this.baseDir = options.baseDir;
    this.git = simpleGit(options.baseDir);
  }

  /**
   * Get the current git status
   */
  async status(): Promise<GitStatus> {
    const result: StatusResult = await this.git.status();

    return {
      branch: result.current ?? 'unknown',
      ahead: result.ahead,
      behind: result.behind,
      staged: result.staged,
      modified: result.modified,
      untracked: result.not_added,
      deleted: result.deleted,
    };
  }

  /**
   * Get recent commits
   */
  async log(maxCount: number = 10): Promise<GitCommitInfo[]> {
    const result: LogResult = await this.git.log({ maxCount });

    return result.all.map(commit => ({
      hash: commit.hash,
      shortHash: commit.hash.slice(0, 7),
      author: commit.author_name,
      email: commit.author_email,
      date: new Date(commit.date),
      message: commit.message,
    }));
  }

  /**
   * Get diff for staged changes
   */
  async diffStaged(): Promise<string> {
    return this.git.diff(['--staged']);
  }

  /**
   * Get diff for unstaged changes
   */
  async diff(): Promise<string> {
    return this.git.diff();
  }

  /**
   * Get diff between two commits
   */
  async diffBetween(from: string, to: string): Promise<string> {
    return this.git.diff([from, to]);
  }

  /**
   * Stage files
   */
  async add(files: string | string[]): Promise<void> {
    await this.git.add(files);
  }

  /**
   * Create a commit
   */
  async commit(message: string): Promise<string> {
    const result = await this.git.commit(message);
    return result.commit;
  }

  /**
   * Get the current branch name
   */
  async currentBranch(): Promise<string> {
    const result = await this.git.branch();
    return result.current;
  }

  /**
   * Create and checkout a new branch
   */
  async createBranch(branchName: string): Promise<void> {
    await this.git.checkoutLocalBranch(branchName);
  }

  /**
   * Checkout an existing branch
   */
  async checkout(branchName: string): Promise<void> {
    await this.git.checkout(branchName);
  }

  /**
   * Get the current HEAD commit hash
   */
  async getHead(): Promise<string> {
    const result = await this.git.revparse(['HEAD']);
    return result.trim();
  }

  /**
   * Check if the directory is a git repository
   */
  async isRepo(): Promise<boolean> {
    return this.git.checkIsRepo();
  }

  /**
   * Initialize a new git repository
   */
  async init(): Promise<void> {
    await this.git.init();
  }

  /**
   * Get list of changed files since a commit
   */
  async getChangedFilesSince(commit: string): Promise<string[]> {
    const diff = await this.git.diff(['--name-only', commit]);
    return diff.split('\n').filter(f => f.trim() !== '');
  }

  /**
   * Stash current changes
   */
  async stash(message?: string): Promise<void> {
    if (message) {
      await this.git.stash(['push', '-m', message]);
    } else {
      await this.git.stash(['push']);
    }
  }

  /**
   * Pop the latest stash
   */
  async stashPop(): Promise<void> {
    await this.git.stash(['pop']);
  }

  /**
   * Reset to a specific commit
   */
  async reset(commit: string, mode: 'soft' | 'mixed' | 'hard' = 'mixed'): Promise<void> {
    await this.git.reset([`--${mode}`, commit]);
  }
}

/**
 * Create a git tool instance
 */
export function createGitTool(baseDir: string): GitTool {
  return new GitTool({ baseDir });
}
