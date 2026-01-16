/**
 * OAuth2 Storage
 * In-memory store with optional persistence to database
 */

import * as crypto from 'node:crypto';
import type {
  OAuthClient,
  OAuthAuthorizationCode,
  OAuthStoredToken,
} from './types.js';

// In-memory stores
const clients = new Map<string, OAuthClient>();
const authCodes = new Map<string, OAuthAuthorizationCode>();
const accessTokens = new Map<string, OAuthStoredToken>();
const refreshTokens = new Map<string, OAuthStoredToken>();

// Token expiration times
const ACCESS_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Generate a secure random string
 */
function generateSecureToken(length = 32): string {
  return crypto.randomBytes(length).toString('base64url');
}

/**
 * Generate a client ID
 */
function generateClientId(): string {
  return `mcp_${generateSecureToken(16)}`;
}

/**
 * Generate a client secret
 */
function generateClientSecret(): string {
  return generateSecureToken(32);
}

// =============================================================================
// Client Management
// =============================================================================

export function createClient(params: {
  client_name: string;
  redirect_uris: string[];
  grant_types?: ('authorization_code' | 'refresh_token')[];
  scope?: string;
  is_public?: boolean;
}): OAuthClient {
  const client: OAuthClient = {
    client_id: generateClientId(),
    client_secret: params.is_public ? undefined : generateClientSecret(),
    client_name: params.client_name,
    redirect_uris: params.redirect_uris,
    grant_types: params.grant_types ?? ['authorization_code', 'refresh_token'],
    scope: params.scope ?? '*',
    created_at: new Date().toISOString(),
  };

  clients.set(client.client_id, client);
  return client;
}

export function getClient(clientId: string): OAuthClient | undefined {
  return clients.get(clientId);
}

export function deleteClient(clientId: string): boolean {
  return clients.delete(clientId);
}

export function listClients(): OAuthClient[] {
  return Array.from(clients.values());
}

export function validateClientCredentials(
  clientId: string,
  clientSecret?: string
): OAuthClient | null {
  const client = clients.get(clientId);
  if (!client) return null;

  // Public clients don't have a secret
  if (!client.client_secret) {
    return client;
  }

  // Confidential clients must provide correct secret
  if (client.client_secret !== clientSecret) {
    return null;
  }

  return client;
}

// =============================================================================
// Authorization Code Management
// =============================================================================

export function createAuthorizationCode(params: {
  client_id: string;
  redirect_uri: string;
  scope: string;
  user_id: string;
  code_challenge?: string;
  code_challenge_method?: 'S256' | 'plain';
}): string {
  const code = generateSecureToken(32);

  const authCode: OAuthAuthorizationCode = {
    code,
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    scope: params.scope,
    user_id: params.user_id,
    code_challenge: params.code_challenge,
    code_challenge_method: params.code_challenge_method,
    expires_at: Date.now() + AUTH_CODE_EXPIRY_MS,
    created_at: new Date().toISOString(),
  };

  authCodes.set(code, authCode);
  return code;
}

export function consumeAuthorizationCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier?: string
): OAuthAuthorizationCode | null {
  const authCode = authCodes.get(code);
  if (!authCode) return null;

  // Delete immediately to prevent reuse
  authCodes.delete(code);

  // Check expiration
  if (Date.now() > authCode.expires_at) {
    return null;
  }

  // Validate client and redirect URI
  if (authCode.client_id !== clientId || authCode.redirect_uri !== redirectUri) {
    return null;
  }

  // Validate PKCE if used
  if (authCode.code_challenge) {
    if (!codeVerifier) return null;

    let computedChallenge: string;
    if (authCode.code_challenge_method === 'S256') {
      computedChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
    } else {
      computedChallenge = codeVerifier;
    }

    if (computedChallenge !== authCode.code_challenge) {
      return null;
    }
  }

  return authCode;
}

// =============================================================================
// Token Management
// =============================================================================

export function createTokens(params: {
  client_id: string;
  user_id: string;
  scope: string;
}): { access_token: string; refresh_token: string; expires_in: number } {
  const accessToken = generateSecureToken(32);
  const refreshToken = generateSecureToken(32);
  const expiresIn = Math.floor(ACCESS_TOKEN_EXPIRY_MS / 1000);

  const storedAccessToken: OAuthStoredToken = {
    access_token: accessToken,
    refresh_token: refreshToken,
    client_id: params.client_id,
    user_id: params.user_id,
    scope: params.scope,
    expires_at: Date.now() + ACCESS_TOKEN_EXPIRY_MS,
    created_at: new Date().toISOString(),
  };

  const storedRefreshToken: OAuthStoredToken = {
    access_token: accessToken,
    refresh_token: refreshToken,
    client_id: params.client_id,
    user_id: params.user_id,
    scope: params.scope,
    expires_at: Date.now() + REFRESH_TOKEN_EXPIRY_MS,
    created_at: new Date().toISOString(),
  };

  accessTokens.set(accessToken, storedAccessToken);
  refreshTokens.set(refreshToken, storedRefreshToken);

  return { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn };
}

export function validateAccessToken(token: string): OAuthStoredToken | null {
  const stored = accessTokens.get(token);
  if (!stored) return null;

  if (Date.now() > stored.expires_at) {
    accessTokens.delete(token);
    return null;
  }

  return stored;
}

export function refreshAccessToken(refreshToken: string): {
  access_token: string;
  refresh_token: string;
  expires_in: number;
} | null {
  const stored = refreshTokens.get(refreshToken);
  if (!stored) return null;

  if (Date.now() > stored.expires_at) {
    refreshTokens.delete(refreshToken);
    return null;
  }

  // Delete old tokens
  if (stored.access_token) {
    accessTokens.delete(stored.access_token);
  }
  refreshTokens.delete(refreshToken);

  // Create new tokens
  return createTokens({
    client_id: stored.client_id,
    user_id: stored.user_id,
    scope: stored.scope,
  });
}

export function revokeToken(token: string): boolean {
  // Try as access token
  const accessStored = accessTokens.get(token);
  if (accessStored) {
    accessTokens.delete(token);
    if (accessStored.refresh_token) {
      refreshTokens.delete(accessStored.refresh_token);
    }
    return true;
  }

  // Try as refresh token
  const refreshStored = refreshTokens.get(token);
  if (refreshStored) {
    refreshTokens.delete(token);
    if (refreshStored.access_token) {
      accessTokens.delete(refreshStored.access_token);
    }
    return true;
  }

  return false;
}

// =============================================================================
// Cleanup
// =============================================================================

export function cleanupExpired(): void {
  const now = Date.now();

  // Cleanup auth codes
  for (const [code, authCode] of authCodes.entries()) {
    if (now > authCode.expires_at) {
      authCodes.delete(code);
    }
  }

  // Cleanup access tokens
  for (const [token, stored] of accessTokens.entries()) {
    if (now > stored.expires_at) {
      accessTokens.delete(token);
    }
  }

  // Cleanup refresh tokens
  for (const [token, stored] of refreshTokens.entries()) {
    if (now > stored.expires_at) {
      refreshTokens.delete(token);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpired, 5 * 60 * 1000);
