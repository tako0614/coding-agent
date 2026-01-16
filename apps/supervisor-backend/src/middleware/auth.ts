/**
 * Authentication Middleware
 * Provides JWT-based authentication for API endpoints
 *
 * Security: This module is critical for API security.
 * All protected endpoints MUST use this middleware.
 */

import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import * as crypto from 'node:crypto';
import { logger } from '../services/logger.js';

// =============================================================================
// Configuration
// =============================================================================

/** JWT secret key - MUST be set in production */
const JWT_SECRET = process.env['JWT_SECRET'] || (
  process.env['NODE_ENV'] === 'production'
    ? (() => { throw new Error('JWT_SECRET must be set in production'); })()
    : 'dev-secret-key-change-in-production'
);

/** Token expiration time in seconds (default: 24 hours) */
const TOKEN_EXPIRY_SECONDS = parseInt(process.env['JWT_EXPIRY_SECONDS'] ?? '86400', 10);

/** API key for simple authentication (alternative to JWT) */
const API_KEY = process.env['API_KEY'];

/** Enable authentication (can be disabled for local development) */
const AUTH_ENABLED = process.env['AUTH_ENABLED'] !== 'false';

/** Paths that don't require authentication */
const PUBLIC_PATHS = [
  '/health',
  '/api/auth/login',
  '/api/auth/token',
];

/** Path prefixes that don't require authentication */
const PUBLIC_PATH_PREFIXES: string[] = [
  // Static files are handled before API middleware
];

// =============================================================================
// Types
// =============================================================================

interface JWTPayload {
  sub: string;           // Subject (user identifier)
  iat: number;           // Issued at (Unix timestamp)
  exp: number;           // Expiration (Unix timestamp)
  scope?: string[];      // Optional scopes/permissions
}

interface AuthContext {
  user: {
    id: string;
    scope: string[];
  };
  token: string;
}

// =============================================================================
// JWT Utilities
// =============================================================================

/**
 * Base64URL encode a string
 */
function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Base64URL decode a string
 */
function base64UrlDecode(str: string): string {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) {
    str += '=';
  }
  return Buffer.from(str, 'base64').toString('utf-8');
}

/**
 * Create HMAC signature for JWT
 */
function createSignature(data: string): string {
  const hmac = crypto.createHmac('sha256', JWT_SECRET);
  hmac.update(data);
  return base64UrlEncode(hmac.digest('base64'));
}

/**
 * Generate a JWT token
 */
export function generateToken(userId: string, scope: string[] = []): string {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const payload: JWTPayload = {
    sub: userId,
    iat: now,
    exp: now + TOKEN_EXPIRY_SECONDS,
    scope,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = createSignature(`${headerB64}.${payloadB64}`);

  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token: string): JWTPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [headerB64, payloadB64, signature] = parts;

    // Verify signature
    const expectedSignature = createSignature(`${headerB64}.${payloadB64}`);
    if (!crypto.timingSafeEqual(
      Buffer.from(signature!, 'utf-8'),
      Buffer.from(expectedSignature, 'utf-8')
    )) {
      logger.warn('JWT signature verification failed');
      return null;
    }

    // Decode payload
    const payload = JSON.parse(base64UrlDecode(payloadB64!)) as JWTPayload;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      logger.debug('JWT token expired', { exp: payload.exp, now });
      return null;
    }

    return payload;
  } catch (error) {
    logger.warn('JWT verification error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// =============================================================================
// Middleware
// =============================================================================

/**
 * Check if a path is public (doesn't require authentication)
 */
function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.includes(path)) {
    return true;
  }

  for (const prefix of PUBLIC_PATH_PREFIXES) {
    if (path.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract token from Authorization header
 * Supports: Bearer <token>, ApiKey <key>
 */
function extractToken(authHeader: string | undefined): { type: 'bearer' | 'apikey'; value: string } | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2) {
    return null;
  }

  const [scheme, value] = parts;
  const schemeLower = scheme!.toLowerCase();

  if (schemeLower === 'bearer') {
    return { type: 'bearer', value: value! };
  }

  if (schemeLower === 'apikey') {
    return { type: 'apikey', value: value! };
  }

  return null;
}

/**
 * Authentication middleware for Hono
 *
 * Usage:
 *   app.use('/api/*', authMiddleware);
 *
 * Or for specific routes:
 *   app.get('/api/protected', authMiddleware, handler);
 */
export const authMiddleware = createMiddleware<{
  Variables: {
    auth: AuthContext;
  };
}>(async (c, next) => {
  // Skip authentication if disabled
  if (!AUTH_ENABLED) {
    // Set a default auth context for development
    c.set('auth', {
      user: { id: 'dev-user', scope: ['*'] },
      token: 'dev-token',
    });
    return next();
  }

  const path = c.req.path;

  // Skip authentication for public paths
  if (isPublicPath(path)) {
    return next();
  }

  // Skip authentication for non-API paths (static files, etc.)
  if (!path.startsWith('/api/') && !path.startsWith('/v1/')) {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  const tokenInfo = extractToken(authHeader);

  if (!tokenInfo) {
    logger.debug('Missing or invalid Authorization header', { path });
    throw new HTTPException(401, {
      message: 'Authentication required',
    });
  }

  // Handle API key authentication
  if (tokenInfo.type === 'apikey') {
    if (!API_KEY) {
      throw new HTTPException(401, {
        message: 'API key authentication not configured',
      });
    }

    // Timing-safe comparison
    const keyBuffer = Buffer.from(tokenInfo.value);
    const expectedBuffer = Buffer.from(API_KEY);

    if (keyBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(keyBuffer, expectedBuffer)) {
      logger.warn('Invalid API key', { path });
      throw new HTTPException(401, {
        message: 'Invalid API key',
      });
    }

    c.set('auth', {
      user: { id: 'api-key-user', scope: ['*'] },
      token: tokenInfo.value,
    });

    return next();
  }

  // Handle JWT authentication
  const payload = verifyToken(tokenInfo.value);

  if (!payload) {
    throw new HTTPException(401, {
      message: 'Invalid or expired token',
    });
  }

  c.set('auth', {
    user: {
      id: payload.sub,
      scope: payload.scope || [],
    },
    token: tokenInfo.value,
  });

  return next();
});

/**
 * Scope-based authorization middleware
 *
 * Usage:
 *   app.get('/api/admin', authMiddleware, requireScope('admin'), handler);
 */
export function requireScope(...requiredScopes: string[]) {
  return createMiddleware<{
    Variables: {
      auth: AuthContext;
    };
  }>(async (c, next) => {
    const auth = c.get('auth');

    if (!auth) {
      throw new HTTPException(401, {
        message: 'Authentication required',
      });
    }

    // Wildcard scope grants all permissions
    if (auth.user.scope.includes('*')) {
      return next();
    }

    // Check if user has any of the required scopes
    const hasScope = requiredScopes.some(scope => auth.user.scope.includes(scope));

    if (!hasScope) {
      logger.warn('Insufficient permissions', {
        userId: auth.user.id,
        required: requiredScopes,
        actual: auth.user.scope,
      });
      throw new HTTPException(403, {
        message: 'Insufficient permissions',
      });
    }

    return next();
  });
}

/**
 * WebSocket authentication helper
 *
 * Usage:
 *   const auth = authenticateWebSocket(request);
 *   if (!auth) { ws.close(1008, 'Unauthorized'); return; }
 */
export function authenticateWebSocket(
  request: { url?: string; headers?: { get: (name: string) => string | null } }
): AuthContext | null {
  // Skip if auth is disabled
  if (!AUTH_ENABLED) {
    return {
      user: { id: 'dev-user', scope: ['*'] },
      token: 'dev-token',
    };
  }

  // Try to get token from query string
  if (request.url) {
    try {
      const url = new URL(request.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (token) {
        const payload = verifyToken(token);
        if (payload) {
          return {
            user: { id: payload.sub, scope: payload.scope || [] },
            token,
          };
        }
      }
    } catch {
      // Ignore URL parsing errors
    }
  }

  // Try to get token from Authorization header
  const authHeader = request.headers?.get('Authorization');
  const tokenInfo = extractToken(authHeader ?? undefined);

  if (tokenInfo?.type === 'bearer') {
    const payload = verifyToken(tokenInfo.value);
    if (payload) {
      return {
        user: { id: payload.sub, scope: payload.scope || [] },
        token: tokenInfo.value,
      };
    }
  }

  if (tokenInfo?.type === 'apikey' && API_KEY) {
    const keyBuffer = Buffer.from(tokenInfo.value);
    const expectedBuffer = Buffer.from(API_KEY);

    if (keyBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(keyBuffer, expectedBuffer)) {
      return {
        user: { id: 'api-key-user', scope: ['*'] },
        token: tokenInfo.value,
      };
    }
  }

  return null;
}

// =============================================================================
// Exports
// =============================================================================

export { AUTH_ENABLED, TOKEN_EXPIRY_SECONDS };
