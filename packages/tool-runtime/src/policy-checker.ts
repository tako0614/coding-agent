/**
 * Policy checker for shell commands and filesystem operations
 */

import type { ShellPolicy, FilesystemPolicy, PolicyCheckResult } from './types.js';
import path from 'node:path';
import os from 'node:os';

/**
 * Check if a shell command is allowed by policy
 */
export function checkShellPolicy(
  command: string,
  policy: ShellPolicy
): PolicyCheckResult {
  const trimmedCmd = command.trim();

  // Check denylist first (highest priority)
  for (const denied of policy.denylist) {
    if (trimmedCmd.includes(denied)) {
      return {
        allowed: false,
        reason: `Command contains denied pattern: "${denied}"`,
      };
    }
  }

  // Extract the base command (first word)
  const parts = trimmedCmd.split(/\s+/);
  const baseCommand = parts[0];
  if (!baseCommand) {
    return {
      allowed: false,
      reason: 'Empty command',
    };
  }

  // Check if base command is in allowlist
  const isAllowed = policy.allowlist.some(allowed => {
    // Handle full path commands
    const cmdName = path.basename(baseCommand);
    return cmdName === allowed || baseCommand === allowed;
  });

  if (!isAllowed) {
    return {
      allowed: false,
      reason: `Command "${baseCommand}" is not in the allowlist`,
    };
  }

  // Check argument patterns for this command
  const argPatterns = policy.argumentPatterns[baseCommand];
  if (argPatterns) {
    // Check forbidden flags
    if (argPatterns.forbiddenFlags) {
      for (const forbidden of argPatterns.forbiddenFlags) {
        if (trimmedCmd.includes(forbidden)) {
          return {
            allowed: false,
            reason: `Command contains forbidden flag pattern: "${forbidden}"`,
          };
        }
      }
    }

    // Check if confirmation is required
    if (argPatterns.requireConfirmation) {
      for (const pattern of argPatterns.requireConfirmation) {
        if (trimmedCmd.includes(pattern)) {
          return {
            allowed: true,
            requiresConfirmation: true,
            confirmationReason: `Command contains pattern that requires confirmation: "${pattern}"`,
          };
        }
      }
    }
  }

  return { allowed: true };
}

/**
 * Check if a filesystem path is writable according to policy
 */
export function checkFilesystemWritePolicy(
  targetPath: string,
  policy: FilesystemPolicy,
  cwd: string
): PolicyCheckResult {
  // Resolve the path
  const resolvedPath = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(cwd, targetPath);

  // Normalize for comparison
  const normalizedPath = path.normalize(resolvedPath);
  const homeDir = os.homedir();

  // Check forbidden paths
  for (const forbidden of policy.forbiddenPaths) {
    // Expand ~ to home directory
    const expandedForbidden = forbidden.startsWith('~/')
      ? path.join(homeDir, forbidden.slice(2))
      : forbidden.startsWith('~')
      ? path.join(homeDir, forbidden.slice(1))
      : forbidden;

    const normalizedForbidden = path.normalize(expandedForbidden);

    if (
      normalizedPath === normalizedForbidden ||
      normalizedPath.startsWith(normalizedForbidden + path.sep)
    ) {
      return {
        allowed: false,
        reason: `Path "${targetPath}" is in forbidden area: "${forbidden}"`,
      };
    }
  }

  // Check if path is within write roots
  for (const root of policy.writeRoots) {
    // Expand ~ and ./
    let expandedRoot: string;
    if (root === './') {
      expandedRoot = cwd;
    } else if (root.startsWith('~/')) {
      expandedRoot = path.join(homeDir, root.slice(2));
    } else if (root.startsWith('./')) {
      expandedRoot = path.join(cwd, root.slice(2));
    } else {
      expandedRoot = root;
    }

    const normalizedRoot = path.normalize(expandedRoot);

    if (
      normalizedPath === normalizedRoot ||
      normalizedPath.startsWith(normalizedRoot + path.sep)
    ) {
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    reason: `Path "${targetPath}" is not within any write root`,
  };
}

/**
 * Load policy from JSON config
 */
export function loadPolicyFromConfig(config: {
  shell?: {
    allowlist?: string[];
    denylist?: string[];
    argument_patterns?: Record<string, {
      forbidden_flags?: string[];
      require_confirmation?: string[];
    }>;
    max_execution_time_ms?: number;
    max_output_size_bytes?: number;
  };
  filesystem?: {
    write_roots?: string[];
    forbidden_paths?: string[];
    max_file_size_bytes?: number;
  };
}): { shell: ShellPolicy; filesystem: FilesystemPolicy } {
  return {
    shell: {
      allowlist: config.shell?.allowlist ?? [],
      denylist: config.shell?.denylist ?? [],
      argumentPatterns: Object.fromEntries(
        Object.entries(config.shell?.argument_patterns ?? {}).map(([cmd, patterns]) => [
          cmd,
          {
            forbiddenFlags: patterns.forbidden_flags,
            requireConfirmation: patterns.require_confirmation,
          },
        ])
      ),
      maxExecutionTimeMs: config.shell?.max_execution_time_ms ?? 300000,
      maxOutputSizeBytes: config.shell?.max_output_size_bytes ?? 10485760,
    },
    filesystem: {
      writeRoots: config.filesystem?.write_roots ?? ['./'],
      forbiddenPaths: config.filesystem?.forbidden_paths ?? [],
      maxFileSizeBytes: config.filesystem?.max_file_size_bytes ?? 52428800,
    },
  };
}
