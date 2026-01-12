/**
 * Custom error types for the Supervisor Backend
 * Provides consistent error handling across the application
 */

/**
 * Base error class for all application errors
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode = 500,
    isOperational = true,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details;

    // Maintains proper stack trace for where our error was thrown
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      details: this.details,
    };
  }
}

/**
 * Database operation errors
 */
export class DatabaseError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'DATABASE_ERROR', 500, true, details);
  }
}

/**
 * Run not found error
 */
export class RunNotFoundError extends AppError {
  constructor(runId: string) {
    super(`Run not found: ${runId}`, 'RUN_NOT_FOUND', 404, true, { runId });
  }
}

/**
 * Run already exists error
 */
export class RunAlreadyExistsError extends AppError {
  constructor(runId: string) {
    super(`Run already exists: ${runId}`, 'RUN_ALREADY_EXISTS', 409, true, { runId });
  }
}

/**
 * Run is in invalid state for requested operation
 */
export class InvalidRunStateError extends AppError {
  constructor(runId: string, currentState: string, expectedStates: string[]) {
    super(
      `Run ${runId} is in invalid state: ${currentState}. Expected: ${expectedStates.join(', ')}`,
      'INVALID_RUN_STATE',
      400,
      true,
      { runId, currentState, expectedStates }
    );
  }
}

/**
 * Validation error for invalid input
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, true, details);
  }
}

/**
 * Path security violation error
 */
export class PathSecurityError extends AppError {
  public readonly attemptedPath: string;
  public readonly allowedRoot: string;

  constructor(message: string, attemptedPath: string = '', allowedRoot: string = '') {
    super(message, 'PATH_SECURITY_ERROR', 403, true, { attemptedPath, allowedRoot });
    this.attemptedPath = attemptedPath;
    this.allowedRoot = allowedRoot;
  }
}

/**
 * Tool execution error
 */
export class ToolExecutionError extends AppError {
  constructor(toolName: string, message: string, details?: Record<string, unknown>) {
    super(`Tool ${toolName} failed: ${message}`, 'TOOL_EXECUTION_ERROR', 500, true, {
      toolName,
      ...details,
    });
  }
}

/**
 * Worker execution error
 */
export class WorkerExecutionError extends AppError {
  constructor(taskId: string, message: string, details?: Record<string, unknown>) {
    super(`Worker task ${taskId} failed: ${message}`, 'WORKER_EXECUTION_ERROR', 500, true, {
      taskId,
      ...details,
    });
  }
}

/**
 * External API error (OpenAI, Anthropic, etc.)
 */
export class ExternalAPIError extends AppError {
  public readonly isRetryable: boolean;

  constructor(
    provider: string,
    message: string,
    isRetryable = false,
    details?: Record<string, unknown>
  ) {
    super(`${provider} API error: ${message}`, 'EXTERNAL_API_ERROR', 502, true, {
      provider,
      ...details,
    });
    this.isRetryable = isRetryable;
  }
}

/**
 * Configuration error
 */
export class ConfigurationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIGURATION_ERROR', 500, false, details);
  }
}

/**
 * Timeout error
 */
export class TimeoutError extends AppError {
  constructor(operation: string, timeoutMs: number) {
    super(
      `Operation '${operation}' timed out after ${Math.round(timeoutMs / 1000)}s`,
      'TIMEOUT_ERROR',
      408,
      true,
      { operation, timeoutMs }
    );
  }
}

/**
 * Concurrency/lock error
 */
export class LockError extends AppError {
  constructor(resource: string, message: string) {
    super(message, 'LOCK_ERROR', 423, true, { resource });
  }
}

/**
 * Helper to check if an error is an AppError
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Helper to wrap unknown errors into AppError
 */
export function wrapError(error: unknown, fallbackCode = 'UNKNOWN_ERROR'): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError(error.message, fallbackCode, 500, true, {
      originalName: error.name,
      stack: error.stack,
    });
  }

  return new AppError(String(error), fallbackCode, 500, true);
}

/**
 * Helper to extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Helper to check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof ExternalAPIError) {
    return error.isRetryable;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('rate limit') ||
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('econnreset') ||
      message.includes('429') ||
      message.includes('503') ||
      message.includes('502')
    );
  }

  return false;
}
