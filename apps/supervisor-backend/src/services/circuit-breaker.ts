/**
 * Circuit Breaker Pattern Implementation
 * Prevents cascading failures by stopping requests to failing services
 */

import { logger } from './logger.js';

/** Error classification for retry logic */
type ErrorType = 'transient' | 'permanent' | 'unknown';

// =============================================================================
// Constants
// =============================================================================

/** Number of failures before opening circuit */
export const FAILURE_THRESHOLD = 5;

/** Time in ms before attempting to close circuit */
export const RECOVERY_TIMEOUT_MS = 30_000;

/** Time window for counting failures */
export const FAILURE_WINDOW_MS = 60_000;

/** Maximum consecutive same errors before giving up */
export const MAX_CONSECUTIVE_SAME_ERROR = 3;

// =============================================================================
// Error Classification
// =============================================================================

/** Patterns for transient errors (should retry) */
const TRANSIENT_ERROR_PATTERNS = [
  /timeout/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /network/i,
  /rate.?limit/i,
  /429/,
  /503/,
  /502/,
  /temporary/i,
  /unavailable/i,
  /overloaded/i,
];

/** Patterns for permanent errors (should not retry) */
const PERMANENT_ERROR_PATTERNS = [
  /syntax.?error/i,
  /invalid.?api.?key/i,
  /unauthorized/i,
  /401/,
  /403/,
  /not.?found/i,
  /404/,
  /invalid.?request/i,
  /400/,
  /type.?error/i,
  /reference.?error/i,
];

/**
 * Classify an error as transient, permanent, or unknown
 */
export function classifyError(error: Error | string): ErrorType {
  const message = typeof error === 'string' ? error : error.message;

  // Check for transient patterns
  for (const pattern of TRANSIENT_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return 'transient';
    }
  }

  // Check for permanent patterns
  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return 'permanent';
    }
  }

  return 'unknown';
}

/**
 * Determine if an error should be retried
 */
export function shouldRetry(errorType: ErrorType, attemptCount: number, maxRetries: number): boolean {
  if (attemptCount >= maxRetries) {
    return false;
  }

  switch (errorType) {
    case 'transient':
      return true;
    case 'permanent':
      return false;
    case 'unknown':
    default:
      // Retry unknown errors up to half the max retries
      return attemptCount < Math.ceil(maxRetries / 2);
  }
}

/**
 * Calculate exponential backoff delay
 */
export function calculateBackoff(
  attemptCount: number,
  baseDelayMs = 1000,
  maxDelayMs = 30000
): number {
  const delay = Math.min(
    baseDelayMs * Math.pow(2, attemptCount),
    maxDelayMs
  );
  // Add jitter (0-25% of delay)
  const jitter = delay * Math.random() * 0.25;
  return Math.floor(delay + jitter);
}

// =============================================================================
// Circuit Breaker
// =============================================================================

type CircuitState = 'closed' | 'open' | 'half-open';

interface FailureRecord {
  timestamp: number;
  error: string;
  errorType: ErrorType;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures: FailureRecord[] = [];
  private lastFailureTime = 0;
  private consecutiveSameError = 0;
  private lastErrorMessage = '';

  constructor(
    private name: string,
    private failureThreshold = FAILURE_THRESHOLD,
    private recoveryTimeoutMs = RECOVERY_TIMEOUT_MS,
    private failureWindowMs = FAILURE_WINDOW_MS
  ) {}

  /**
   * Check if circuit allows requests
   */
  isAllowed(): boolean {
    this.pruneOldFailures();

    switch (this.state) {
      case 'closed':
        return true;

      case 'open':
        // Check if recovery timeout has passed
        if (Date.now() - this.lastFailureTime >= this.recoveryTimeoutMs) {
          this.state = 'half-open';
          logger.info('Circuit breaker half-open', { name: this.name });
          return true;
        }
        return false;

      case 'half-open':
        return true;
    }
  }

  /**
   * Record a successful request
   */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.failures = [];
      this.consecutiveSameError = 0;
      this.lastErrorMessage = '';
      logger.info('Circuit breaker closed', { name: this.name });
    }
  }

  /**
   * Record a failed request
   */
  recordFailure(error: Error | string): void {
    const message = typeof error === 'string' ? error : error.message;
    const errorType = classifyError(error);
    const now = Date.now();

    this.failures.push({
      timestamp: now,
      error: message,
      errorType,
    });
    this.lastFailureTime = now;

    // Track consecutive same errors
    if (message === this.lastErrorMessage) {
      this.consecutiveSameError++;
    } else {
      this.consecutiveSameError = 1;
      this.lastErrorMessage = message;
    }

    this.pruneOldFailures();

    // Check if circuit should open
    const recentFailures = this.failures.length;
    if (recentFailures >= this.failureThreshold || this.consecutiveSameError >= MAX_CONSECUTIVE_SAME_ERROR) {
      this.state = 'open';
      logger.warn('Circuit breaker opened', {
        name: this.name,
        failures: recentFailures,
        consecutiveSameError: this.consecutiveSameError,
        lastError: message,
      });
    }

    // If in half-open state, go back to open on any failure
    if (this.state === 'half-open') {
      this.state = 'open';
      logger.warn('Circuit breaker reopened from half-open', { name: this.name });
    }
  }

  /**
   * Remove failures outside the time window
   */
  private pruneOldFailures(): void {
    const cutoff = Date.now() - this.failureWindowMs;
    this.failures = this.failures.filter(f => f.timestamp > cutoff);
  }

  /**
   * Get circuit state
   */
  getState(): CircuitState {
    this.pruneOldFailures();
    return this.state;
  }

  /**
   * Get failure count in current window
   */
  getFailureCount(): number {
    this.pruneOldFailures();
    return this.failures.length;
  }

  /**
   * Get consecutive same error count
   */
  getConsecutiveSameErrorCount(): number {
    return this.consecutiveSameError;
  }

  /**
   * Force reset the circuit breaker
   */
  reset(): void {
    this.state = 'closed';
    this.failures = [];
    this.consecutiveSameError = 0;
    this.lastErrorMessage = '';
    this.lastFailureTime = 0;
    logger.info('Circuit breaker reset', { name: this.name });
  }

  /**
   * Get status for monitoring
   */
  getStatus(): {
    name: string;
    state: CircuitState;
    failureCount: number;
    consecutiveSameError: number;
    lastFailureTime: number | null;
  } {
    this.pruneOldFailures();
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failures.length,
      consecutiveSameError: this.consecutiveSameError,
      lastFailureTime: this.lastFailureTime || null,
    };
  }
}

// =============================================================================
// Global Circuit Breakers
// =============================================================================

const circuitBreakers = new Map<string, CircuitBreaker>();

/**
 * Get or create a circuit breaker by name
 */
export function getCircuitBreaker(name: string): CircuitBreaker {
  let breaker = circuitBreakers.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker(name);
    circuitBreakers.set(name, breaker);
  }
  return breaker;
}

/**
 * Get all circuit breaker statuses
 */
export function getAllCircuitBreakerStatus(): ReturnType<CircuitBreaker['getStatus']>[] {
  return Array.from(circuitBreakers.values()).map(b => b.getStatus());
}

/**
 * Reset all circuit breakers
 */
export function resetAllCircuitBreakers(): void {
  for (const breaker of circuitBreakers.values()) {
    breaker.reset();
  }
}
