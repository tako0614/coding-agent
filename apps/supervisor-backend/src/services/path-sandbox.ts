/**
 * Path Sandbox - Secure path validation to prevent directory traversal
 *
 * SECURITY: This module provides critical security controls for file operations.
 * All file/directory operations MUST use these validation functions.
 */

import { resolve, normalize, relative, isAbsolute } from 'node:path';
import { realpath, stat, lstat } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { logger } from './logger.js';
import { PathSecurityError } from './errors.js';

// Re-export PathSecurityError from the canonical location
export { PathSecurityError };

/**
 * Options for path validation
 */
export interface ValidatePathOptions {
  /** Allow creating new files/directories (path doesn't exist yet) */
  allowCreate?: boolean;
  /** Follow symlinks and validate final target */
  followSymlinks?: boolean;
  /** Additional allowed roots (for multi-root access) */
  additionalRoots?: string[];
}

/**
 * Validate and normalize a path to ensure it stays within allowed boundaries
 *
 * SECURITY CHECKS:
 * 1. Null bytes and control characters
 * 2. Path traversal sequences (../ etc)
 * 3. Symlink resolution to prevent escape
 * 4. Final path must be under allowed root(s)
 *
 * @param rootPath - The allowed root directory
 * @param userPath - The user-provided path (relative or absolute)
 * @param options - Validation options
 * @returns The validated absolute path
 * @throws PathSecurityError if validation fails
 */
export async function validatePath(
  rootPath: string,
  userPath: string,
  options: ValidatePathOptions = {}
): Promise<string> {
  const { allowCreate = false, followSymlinks = true, additionalRoots = [] } = options;

  // Check for null bytes and control characters (except newlines in some cases)
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(userPath)) {
    throw new PathSecurityError(
      'Invalid characters in path (null bytes or control characters)',
      userPath,
      rootPath
    );
  }

  // Normalize the root path
  const normalizedRoot = resolve(rootPath);

  // Build candidate path
  let candidatePath: string;
  if (isAbsolute(userPath)) {
    candidatePath = normalize(userPath);
  } else {
    candidatePath = resolve(normalizedRoot, userPath);
  }

  // Normalize to remove .. and . segments
  candidatePath = normalize(candidatePath);

  // Quick check: candidate must start with root (before symlink resolution)
  const allRoots = [normalizedRoot, ...additionalRoots.map(r => resolve(r))];
  const passesInitialCheck = allRoots.some(root => {
    const normalizedRootWithSep = root.endsWith('/') || root.endsWith('\\')
      ? root
      : root + (process.platform === 'win32' ? '\\' : '/');
    return candidatePath === root || candidatePath.startsWith(normalizedRootWithSep);
  });

  if (!passesInitialCheck) {
    throw new PathSecurityError(
      `Path traversal detected: path escapes allowed root`,
      userPath,
      rootPath
    );
  }

  // Check if path exists
  const pathExists = existsSync(candidatePath);

  if (!pathExists) {
    if (!allowCreate) {
      throw new PathSecurityError(
        `Path does not exist: ${userPath}`,
        userPath,
        rootPath
      );
    }
    // For non-existent paths, validate the parent directory exists and is safe
    const parentDir = resolve(candidatePath, '..');
    if (existsSync(parentDir)) {
      // Validate parent directory - don't swallow errors
      await validatePath(rootPath, relative(normalizedRoot, parentDir), {
        ...options,
        allowCreate: false,
      });
    }
    // Parent validation passed (or doesn't exist), initial check passed
    return candidatePath;
  }

  // Resolve symlinks to get actual path
  let resolvedPath: string;
  if (followSymlinks) {
    try {
      resolvedPath = await realpath(candidatePath);
    } catch (err) {
      // realpath failed - path might be broken symlink
      throw new PathSecurityError(
        `Cannot resolve path (broken symlink or permission denied)`,
        userPath,
        rootPath
      );
    }
  } else {
    resolvedPath = candidatePath;
  }

  // Final check: resolved path must be under allowed roots
  const passesFinalCheck = allRoots.some(root => {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      realRoot = root;
    }
    const rootWithSep = realRoot.endsWith('/') || realRoot.endsWith('\\')
      ? realRoot
      : realRoot + (process.platform === 'win32' ? '\\' : '/');
    return resolvedPath === realRoot || resolvedPath.startsWith(rootWithSep);
  });

  if (!passesFinalCheck) {
    logger.warn('Path security violation (symlink escape attempt)', {
      userPath,
      candidatePath,
      resolvedPath,
      allowedRoots: allRoots,
    });
    throw new PathSecurityError(
      `Path traversal via symlink detected: resolved path escapes allowed root`,
      userPath,
      rootPath
    );
  }

  return resolvedPath;
}

/**
 * Synchronous version of validatePath for simpler use cases
 * Note: Does not follow symlinks as thoroughly as async version
 */
export function validatePathSync(
  rootPath: string,
  userPath: string,
  options: Omit<ValidatePathOptions, 'followSymlinks'> = {}
): string {
  const { allowCreate = false, additionalRoots = [] } = options;

  // Check for null bytes and control characters
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(userPath)) {
    throw new PathSecurityError(
      'Invalid characters in path',
      userPath,
      rootPath
    );
  }

  const normalizedRoot = resolve(rootPath);

  let candidatePath: string;
  if (isAbsolute(userPath)) {
    candidatePath = normalize(userPath);
  } else {
    candidatePath = resolve(normalizedRoot, userPath);
  }

  candidatePath = normalize(candidatePath);

  const allRoots = [normalizedRoot, ...additionalRoots.map(r => resolve(r))];
  const passesCheck = allRoots.some(root => {
    const rootWithSep = root.endsWith('/') || root.endsWith('\\')
      ? root
      : root + (process.platform === 'win32' ? '\\' : '/');
    return candidatePath === root || candidatePath.startsWith(rootWithSep);
  });

  if (!passesCheck) {
    throw new PathSecurityError(
      `Path traversal detected`,
      userPath,
      rootPath
    );
  }

  const pathExists = existsSync(candidatePath);
  if (!pathExists && !allowCreate) {
    throw new PathSecurityError(
      `Path does not exist`,
      userPath,
      rootPath
    );
  }

  // Check for symlink escape (sync version)
  if (pathExists) {
    try {
      const resolvedPath = realpathSync(candidatePath);
      const passesFinalCheck = allRoots.some(root => {
        let realRoot: string;
        try {
          realRoot = realpathSync(root);
        } catch {
          realRoot = root;
        }
        const rootWithSep = realRoot.endsWith('/') || realRoot.endsWith('\\')
          ? realRoot
          : realRoot + (process.platform === 'win32' ? '\\' : '/');
        return resolvedPath === realRoot || resolvedPath.startsWith(rootWithSep);
      });

      if (!passesFinalCheck) {
        throw new PathSecurityError(
          `Symlink escape detected`,
          userPath,
          rootPath
        );
      }
      return resolvedPath;
    } catch (err) {
      if (err instanceof PathSecurityError) throw err;
      throw new PathSecurityError(
        `Cannot resolve path`,
        userPath,
        rootPath
      );
    }
  }

  return candidatePath;
}

/**
 * Validate repo_path provided by user
 * Ensures it's a valid directory and doesn't escape system boundaries
 */
export function validateRepoPath(repoPath: string): string {
  // Must be absolute
  if (!isAbsolute(repoPath)) {
    throw new PathSecurityError(
      'Repository path must be absolute',
      repoPath,
      ''
    );
  }

  // Normalize
  const normalized = normalize(repoPath);

  // Check for control characters
  if (/[\x00-\x1f]/.test(normalized)) {
    throw new PathSecurityError(
      'Invalid characters in repository path',
      repoPath,
      ''
    );
  }

  // Must exist
  if (!existsSync(normalized)) {
    throw new PathSecurityError(
      'Repository path does not exist',
      repoPath,
      ''
    );
  }

  // Resolve symlinks
  let resolved: string;
  try {
    resolved = realpathSync(normalized);
  } catch {
    throw new PathSecurityError(
      'Cannot resolve repository path',
      repoPath,
      ''
    );
  }

  // Block system-critical directories (optional safety net)
  const blockedPaths = [
    '/etc', '/usr', '/bin', '/sbin', '/var', '/root',
    'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
  ].map(p => normalize(p).toLowerCase());

  const resolvedLower = resolved.toLowerCase();
  for (const blocked of blockedPaths) {
    if (resolvedLower === blocked || resolvedLower.startsWith(blocked + (process.platform === 'win32' ? '\\' : '/'))) {
      throw new PathSecurityError(
        'Repository path points to protected system directory',
        repoPath,
        ''
      );
    }
  }

  return resolved;
}
