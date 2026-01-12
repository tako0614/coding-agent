/**
 * Run Lock Service
 *
 * Provides mutex/lock mechanism for run operations to prevent:
 * - Concurrent modifications to conversation history
 * - Race conditions in state updates
 * - Duplicate tool executions
 *
 * Uses a simple in-memory lock with timeout to prevent deadlocks
 */

import { logger } from './logger.js';

export interface LockInfo {
  runId: string;
  acquiredAt: Date;
  operation: string;
  timeoutMs: number;
}

export interface AcquireLockOptions {
  /** Operation name for logging/debugging */
  operation: string;
  /** Maximum wait time to acquire lock (ms) */
  waitTimeoutMs?: number;
  /** Maximum time to hold lock (ms) - prevents deadlocks */
  holdTimeoutMs?: number;
  /** Polling interval when waiting for lock (ms) */
  pollIntervalMs?: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;  // 30 seconds to wait for lock
const DEFAULT_HOLD_TIMEOUT_MS = 300_000; // 5 minutes max hold time
const DEFAULT_POLL_INTERVAL_MS = 100;    // 100ms poll interval

/**
 * Lock Manager for run-level operations
 */
class RunLockManager {
  private locks: Map<string, LockInfo> = new Map();
  private waitQueues: Map<string, Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    operation: string;
  }>> = new Map();

  /**
   * Acquire a lock for a run
   * @returns A release function to call when done
   */
  async acquire(runId: string, options: AcquireLockOptions): Promise<() => void> {
    const {
      operation,
      waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
      holdTimeoutMs = DEFAULT_HOLD_TIMEOUT_MS,
      pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    } = options;

    const startTime = Date.now();

    // Check for existing lock
    const existingLock = this.locks.get(runId);
    if (existingLock) {
      // Check if existing lock has timed out
      const lockAge = Date.now() - existingLock.acquiredAt.getTime();
      if (lockAge > existingLock.timeoutMs) {
        logger.warn('Force releasing timed-out lock', {
          runId,
          operation: existingLock.operation,
          ageMs: lockAge,
        });
        this.locks.delete(runId);
      } else {
        // Wait for lock to be released
        const acquired = await this.waitForLock(runId, operation, waitTimeoutMs, pollIntervalMs);
        if (!acquired) {
          throw new LockTimeoutError(
            `Timeout waiting for lock on run ${runId}`,
            runId,
            operation,
            existingLock.operation
          );
        }
      }
    }

    // Acquire the lock
    const lockInfo: LockInfo = {
      runId,
      acquiredAt: new Date(),
      operation,
      timeoutMs: holdTimeoutMs,
    };
    this.locks.set(runId, lockInfo);

    logger.debug('Lock acquired', { runId, operation });

    // Create release function
    let released = false;
    const release = () => {
      if (released) return;
      released = true;

      const currentLock = this.locks.get(runId);
      if (currentLock && currentLock.acquiredAt === lockInfo.acquiredAt) {
        this.locks.delete(runId);
        logger.debug('Lock released', {
          runId,
          operation,
          heldMs: Date.now() - lockInfo.acquiredAt.getTime(),
        });

        // Notify waiting operations
        this.notifyWaiters(runId);
      }
    };

    // Set auto-release timeout
    setTimeout(() => {
      if (!released) {
        logger.warn('Auto-releasing lock due to timeout', {
          runId,
          operation,
          timeoutMs: holdTimeoutMs,
        });
        release();
      }
    }, holdTimeoutMs);

    return release;
  }

  /**
   * Wait for a lock to be released
   */
  private waitForLock(
    runId: string,
    operation: string,
    timeoutMs: number,
    pollIntervalMs: number
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const startTime = Date.now();

      const checkLock = () => {
        const elapsed = Date.now() - startTime;
        if (elapsed > timeoutMs) {
          // Remove from wait queue
          this.removeFromWaitQueue(runId, operation);
          resolve(false);
          return;
        }

        const lock = this.locks.get(runId);
        if (!lock) {
          // Lock is free
          resolve(true);
          return;
        }

        // Check if lock timed out
        const lockAge = Date.now() - lock.acquiredAt.getTime();
        if (lockAge > lock.timeoutMs) {
          this.locks.delete(runId);
          resolve(true);
          return;
        }

        // Continue waiting
        setTimeout(checkLock, pollIntervalMs);
      };

      // Add to wait queue
      this.addToWaitQueue(runId, operation, () => resolve(true), (err) => reject(err));

      // Start polling
      checkLock();
    });
  }

  private addToWaitQueue(
    runId: string,
    operation: string,
    resolve: () => void,
    reject: (err: Error) => void
  ): void {
    let queue = this.waitQueues.get(runId);
    if (!queue) {
      queue = [];
      this.waitQueues.set(runId, queue);
    }
    queue.push({ resolve, reject, operation });
  }

  private removeFromWaitQueue(runId: string, operation: string): void {
    const queue = this.waitQueues.get(runId);
    if (queue) {
      const index = queue.findIndex(w => w.operation === operation);
      if (index !== -1) {
        queue.splice(index, 1);
      }
      if (queue.length === 0) {
        this.waitQueues.delete(runId);
      }
    }
  }

  private notifyWaiters(runId: string): void {
    const queue = this.waitQueues.get(runId);
    if (queue && queue.length > 0) {
      // Notify first waiter (FIFO)
      const waiter = queue.shift();
      if (waiter) {
        waiter.resolve();
      }
      if (queue.length === 0) {
        this.waitQueues.delete(runId);
      }
    }
  }

  /**
   * Check if a run is currently locked
   */
  isLocked(runId: string): boolean {
    const lock = this.locks.get(runId);
    if (!lock) return false;

    // Check timeout
    const lockAge = Date.now() - lock.acquiredAt.getTime();
    if (lockAge > lock.timeoutMs) {
      this.locks.delete(runId);
      return false;
    }

    return true;
  }

  /**
   * Get lock info for a run
   */
  getLockInfo(runId: string): LockInfo | undefined {
    return this.locks.get(runId);
  }

  /**
   * Get all active locks (for debugging)
   */
  getAllLocks(): LockInfo[] {
    const now = Date.now();
    const activeLocks: LockInfo[] = [];

    for (const [runId, lock] of this.locks.entries()) {
      const lockAge = now - lock.acquiredAt.getTime();
      if (lockAge <= lock.timeoutMs) {
        activeLocks.push(lock);
      } else {
        // Clean up expired lock
        this.locks.delete(runId);
      }
    }

    return activeLocks;
  }

  /**
   * Force release all locks (for shutdown/testing)
   */
  releaseAll(): void {
    for (const [runId] of this.locks) {
      this.notifyWaiters(runId);
    }
    this.locks.clear();
    this.waitQueues.clear();
  }
}

/**
 * Error thrown when lock acquisition times out
 */
export class LockTimeoutError extends Error {
  constructor(
    message: string,
    public readonly runId: string,
    public readonly operation: string,
    public readonly blockingOperation?: string
  ) {
    super(message);
    this.name = 'LockTimeoutError';
  }
}

// Singleton instance
export const runLockManager = new RunLockManager();

/**
 * Helper function to execute an operation with a lock
 * Automatically acquires and releases the lock
 */
export async function withRunLock<T>(
  runId: string,
  operation: string,
  fn: () => Promise<T>,
  options?: Partial<Omit<AcquireLockOptions, 'operation'>>
): Promise<T> {
  const release = await runLockManager.acquire(runId, {
    operation,
    ...options,
  });

  try {
    return await fn();
  } finally {
    release();
  }
}
