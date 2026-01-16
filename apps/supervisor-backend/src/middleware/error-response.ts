/**
 * Standardized API Error Response Utilities
 *
 * Provides consistent error response formatting across all API endpoints.
 */

import type { Context } from 'hono';

/**
 * Standard error types used across the API
 */
export type ErrorType =
  | 'invalid_request'
  | 'authentication_error'
  | 'authorization_error'
  | 'not_found'
  | 'conflict'
  | 'rate_limit_exceeded'
  | 'internal_error'
  | 'service_unavailable'
  | 'payload_too_large';

/**
 * Standard error response structure
 */
export interface APIError {
  error: {
    message: string;
    type: ErrorType;
    code?: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Create a standardized error response
 */
export function createErrorResponse(
  message: string,
  type: ErrorType,
  options?: {
    code?: string;
    details?: Record<string, unknown>;
  }
): APIError {
  const error: APIError = {
    error: {
      message,
      type,
    },
  };

  if (options?.code) {
    error.error.code = options.code;
  }

  if (options?.details) {
    error.error.details = options.details;
  }

  return error;
}

/**
 * HTTP status codes for each error type
 */
export const errorTypeToStatus: Record<ErrorType, number> = {
  invalid_request: 400,
  authentication_error: 401,
  authorization_error: 403,
  not_found: 404,
  conflict: 409,
  rate_limit_exceeded: 429,
  payload_too_large: 413,
  internal_error: 500,
  service_unavailable: 503,
};

/**
 * Send a standardized error response
 */
export function sendError(
  c: Context,
  message: string,
  type: ErrorType,
  options?: {
    code?: string;
    details?: Record<string, unknown>;
    status?: number;
  }
) {
  const status = options?.status ?? errorTypeToStatus[type];
  return c.json(createErrorResponse(message, type, options), status as 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503);
}

/**
 * Common error response helpers
 */
export const errorResponses = {
  badRequest: (c: Context, message: string, code?: string) =>
    sendError(c, message, 'invalid_request', { code }),

  unauthorized: (c: Context, message = 'Authentication required') =>
    sendError(c, message, 'authentication_error'),

  forbidden: (c: Context, message = 'Insufficient permissions') =>
    sendError(c, message, 'authorization_error'),

  notFound: (c: Context, resource = 'Resource') =>
    sendError(c, `${resource} not found`, 'not_found'),

  conflict: (c: Context, message: string, code?: string) =>
    sendError(c, message, 'conflict', { code }),

  internalError: (c: Context, message = 'Internal server error') =>
    sendError(c, message, 'internal_error'),
};
