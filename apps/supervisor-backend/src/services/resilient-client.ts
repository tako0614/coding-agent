/**
 * Resilient HTTP Client Wrapper
 *
 * Provides circuit breaker and timeout functionality for external API calls.
 * Use this wrapper for all external HTTP calls to prevent cascading failures.
 */

import {
  CircuitBreaker,
  getCircuitBreaker,
  classifyError,
  shouldRetry,
  calculateBackoff,
} from './circuit-breaker.js';
import { logger } from './logger.js';

// =============================================================================
// Configuration
// =============================================================================

/** Default timeout for API calls (30 seconds) */
const DEFAULT_TIMEOUT_MS = parseInt(process.env['API_TIMEOUT_MS'] ?? '30000', 10);

/** Maximum retries for transient failures */
const DEFAULT_MAX_RETRIES = parseInt(process.env['API_MAX_RETRIES'] ?? '3', 10);

// =============================================================================
// Types
// =============================================================================

export interface ResilientCallOptions {
  /** Service name for circuit breaker (e.g., 'anthropic', 'openai') */
  service: string;
  /** Operation name for logging */
  operation?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Maximum retries */
  maxRetries?: number;
  /** Whether to use circuit breaker */
  useCircuitBreaker?: boolean;
  /** AbortSignal for external cancellation */
  signal?: AbortSignal;
}

export class ServiceUnavailableError extends Error {
  public readonly service: string;
  public readonly originalCause?: Error;

  constructor(message: string, service: string, cause?: Error) {
    super(message);
    this.name = 'ServiceUnavailableError';
    this.service = service;
    this.originalCause = cause;
  }
}

export class TimeoutError extends Error {
  constructor(
    message: string,
    public readonly service: string,
    public readonly timeoutMs: number
  ) {
    super(message);
    this.name = 'TimeoutError';
  }
}

// =============================================================================
// Resilient Call Wrapper
// =============================================================================

/**
 * Execute a function with circuit breaker, timeout, and retry logic
 */
export async function resilientCall<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: ResilientCallOptions
): Promise<T> {
  const {
    service,
    operation = 'call',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    useCircuitBreaker = true,
    signal: externalSignal,
  } = options;

  const breaker = useCircuitBreaker ? getCircuitBreaker(service) : null;

  // Check circuit breaker
  if (breaker && !breaker.isAllowed()) {
    const state = breaker.getState();
    logger.warn('Circuit breaker open, rejecting request', {
      service,
      operation,
      state,
    });
    throw new ServiceUnavailableError(
      `Service ${service} is currently unavailable (circuit breaker open)`,
      service
    );
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check if externally cancelled
    if (externalSignal?.aborted) {
      throw new Error(`Request cancelled: ${externalSignal.reason || 'aborted'}`);
    }

    try {
      // Create timeout abort controller
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => {
        timeoutController.abort(new TimeoutError(
          `Request timed out after ${timeoutMs}ms`,
          service,
          timeoutMs
        ));
      }, timeoutMs);

      // Combine external signal with timeout
      const combinedSignal = externalSignal
        ? AbortSignal.any([externalSignal, timeoutController.signal])
        : timeoutController.signal;

      try {
        const result = await fn(combinedSignal);

        // Success - clear timeout and record success
        clearTimeout(timeoutId);
        breaker?.recordSuccess();

        if (attempt > 0) {
          logger.info('Request succeeded after retry', {
            service,
            operation,
            attempt,
          });
        }

        return result;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;

      // Record failure with circuit breaker
      breaker?.recordFailure(err);

      // Classify error and determine if retry is appropriate
      const errorType = classifyError(err);
      const canRetry = shouldRetry(errorType, attempt, maxRetries);

      logger.warn('Request failed', {
        service,
        operation,
        attempt,
        errorType,
        canRetry,
        error: err.message,
      });

      if (!canRetry) {
        throw err;
      }

      // Calculate backoff delay
      const backoffMs = calculateBackoff(attempt);
      logger.debug('Retrying after backoff', {
        service,
        operation,
        backoffMs,
        nextAttempt: attempt + 1,
      });

      await sleep(backoffMs);
    }
  }

  // Should not reach here, but throw last error if we do
  throw lastError || new Error(`Failed after ${maxRetries} retries`);
}

/**
 * Create a wrapped version of a function with resilience
 */
export function withResilience<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  options: Omit<ResilientCallOptions, 'signal'>
): T {
  return ((...args: Parameters<T>) => {
    return resilientCall(
      () => fn(...args) as Promise<ReturnType<T>>,
      options
    );
  }) as T;
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a fetch wrapper with resilience
 */
export async function resilientFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number; service?: string } = {}
): Promise<Response> {
  const { timeoutMs, service = 'http', ...fetchInit } = init;

  return resilientCall(
    async (signal) => {
      const response = await fetch(url, {
        ...fetchInit,
        signal,
      });

      // Treat non-2xx responses as errors for circuit breaker
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    },
    {
      service,
      operation: `fetch:${url}`,
      timeoutMs,
    }
  );
}

// =============================================================================
// Anthropic Client Wrapper
// =============================================================================

/**
 * Wrap Anthropic SDK message creation with resilience
 */
export async function resilientAnthropicMessage<T>(
  fn: () => Promise<T>,
  options?: Partial<ResilientCallOptions>
): Promise<T> {
  return resilientCall(
    () => fn(),
    {
      service: 'anthropic',
      operation: 'messages.create',
      timeoutMs: 60000, // 60 seconds for LLM calls
      maxRetries: 2,
      ...options,
    }
  );
}

/**
 * Wrap OpenAI SDK calls with resilience
 */
export async function resilientOpenAICall<T>(
  fn: () => Promise<T>,
  options?: Partial<ResilientCallOptions>
): Promise<T> {
  return resilientCall(
    () => fn(),
    {
      service: 'openai',
      operation: 'chat.completions',
      timeoutMs: 60000,
      maxRetries: 2,
      ...options,
    }
  );
}
