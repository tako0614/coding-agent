/**
 * OAuth2 HTTP Routes
 * Implements OAuth2 authorization code flow with PKCE
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  getClient,
  createClient,
  deleteClient,
  listClients,
  createAuthorizationCode,
  consumeAuthorizationCode,
  createTokens,
  refreshAccessToken,
  revokeToken,
  validateAccessToken,
} from './store.js';
import type { OAuthToken, OAuthError, OAUTH_SCOPES } from './types.js';

export const oauthRoutes = new Hono();

// Enable CORS for OAuth endpoints
oauthRoutes.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// =============================================================================
// Authorization Endpoint
// =============================================================================

oauthRoutes.get('/authorize', async (c) => {
  const {
    response_type,
    client_id,
    redirect_uri,
    scope,
    state,
    code_challenge,
    code_challenge_method,
  } = c.req.query();

  // Validate required parameters
  if (response_type !== 'code') {
    return c.json({ error: 'unsupported_response_type' } as OAuthError, 400);
  }

  if (!client_id || !redirect_uri) {
    return c.json({ error: 'invalid_request', error_description: 'Missing client_id or redirect_uri' } as OAuthError, 400);
  }

  // Validate client
  const client = getClient(client_id);
  if (!client) {
    return c.json({ error: 'invalid_client' } as OAuthError, 401);
  }

  // Validate redirect URI
  if (!client.redirect_uris.includes(redirect_uri)) {
    return c.json({ error: 'invalid_redirect_uri' } as OAuthError, 400);
  }

  // Validate PKCE for public clients
  if (!client.client_secret && !code_challenge) {
    return c.json({ error: 'invalid_request', error_description: 'PKCE required for public clients' } as OAuthError, 400);
  }

  // For now, auto-approve (in production, show consent screen)
  // TODO: Add consent screen UI
  const requestedScope = scope || client.scope;
  const userId = 'default-user'; // TODO: Get from session

  const code = createAuthorizationCode({
    client_id,
    redirect_uri,
    scope: requestedScope,
    user_id: userId,
    code_challenge,
    code_challenge_method: code_challenge_method as 'S256' | 'plain' | undefined,
  });

  // Build redirect URL
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) {
    redirectUrl.searchParams.set('state', state);
  }

  return c.redirect(redirectUrl.toString());
});

// =============================================================================
// Token Endpoint
// =============================================================================

oauthRoutes.post('/token', async (c) => {
  const contentType = c.req.header('Content-Type');
  let body: Record<string, string>;

  if (contentType?.includes('application/json')) {
    body = await c.req.json();
  } else {
    // application/x-www-form-urlencoded
    const formData = await c.req.parseBody();
    body = formData as Record<string, string>;
  }

  const {
    grant_type,
    code,
    redirect_uri,
    client_id,
    client_secret,
    code_verifier,
    refresh_token,
  } = body;

  // Authorization Code Grant
  if (grant_type === 'authorization_code') {
    if (!code || !redirect_uri || !client_id) {
      return c.json({ error: 'invalid_request' } as OAuthError, 400);
    }

    // Validate client
    const client = getClient(client_id);
    if (!client) {
      return c.json({ error: 'invalid_client' } as OAuthError, 401);
    }

    // Validate client secret for confidential clients
    if (client.client_secret && client.client_secret !== client_secret) {
      return c.json({ error: 'invalid_client' } as OAuthError, 401);
    }

    // Consume authorization code
    const authCode = consumeAuthorizationCode(code, client_id, redirect_uri, code_verifier);
    if (!authCode) {
      return c.json({ error: 'invalid_grant' } as OAuthError, 400);
    }

    // Create tokens
    const tokens = createTokens({
      client_id,
      user_id: authCode.user_id,
      scope: authCode.scope,
    });

    const response: OAuthToken = {
      access_token: tokens.access_token,
      token_type: 'Bearer',
      expires_in: tokens.expires_in,
      refresh_token: tokens.refresh_token,
      scope: authCode.scope,
    };

    return c.json(response);
  }

  // Refresh Token Grant
  if (grant_type === 'refresh_token') {
    if (!refresh_token) {
      return c.json({ error: 'invalid_request' } as OAuthError, 400);
    }

    const tokens = refreshAccessToken(refresh_token);
    if (!tokens) {
      return c.json({ error: 'invalid_grant' } as OAuthError, 400);
    }

    const response: OAuthToken = {
      access_token: tokens.access_token,
      token_type: 'Bearer',
      expires_in: tokens.expires_in,
      refresh_token: tokens.refresh_token,
      scope: '*', // TODO: Preserve original scope
    };

    return c.json(response);
  }

  return c.json({ error: 'unsupported_grant_type' } as OAuthError, 400);
});

// =============================================================================
// Token Revocation
// =============================================================================

oauthRoutes.post('/revoke', async (c) => {
  const body = await c.req.parseBody();
  const token = body['token'] as string;

  if (!token) {
    return c.json({ error: 'invalid_request' } as OAuthError, 400);
  }

  revokeToken(token);
  return c.body(null, 200);
});

// =============================================================================
// Token Introspection
// =============================================================================

oauthRoutes.post('/introspect', async (c) => {
  const body = await c.req.parseBody();
  const token = body['token'] as string;

  if (!token) {
    return c.json({ active: false });
  }

  const stored = validateAccessToken(token);
  if (!stored) {
    return c.json({ active: false });
  }

  return c.json({
    active: true,
    client_id: stored.client_id,
    scope: stored.scope,
    sub: stored.user_id,
    exp: Math.floor(stored.expires_at / 1000),
    iat: Math.floor(new Date(stored.created_at).getTime() / 1000),
  });
});

// =============================================================================
// Client Registration (Dynamic Client Registration - RFC 7591)
// =============================================================================

oauthRoutes.post('/register', async (c) => {
  const body = await c.req.json();

  const {
    client_name,
    redirect_uris,
    grant_types,
    scope,
    token_endpoint_auth_method,
  } = body;

  if (!client_name || !redirect_uris || !Array.isArray(redirect_uris)) {
    return c.json({ error: 'invalid_client_metadata' } as OAuthError, 400);
  }

  // Validate redirect URIs
  for (const uri of redirect_uris) {
    try {
      new URL(uri);
    } catch {
      return c.json({ error: 'invalid_redirect_uri' } as OAuthError, 400);
    }
  }

  const isPublic = token_endpoint_auth_method === 'none';

  const client = createClient({
    client_name,
    redirect_uris,
    grant_types,
    scope,
    is_public: isPublic,
  });

  return c.json({
    client_id: client.client_id,
    client_secret: client.client_secret,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    scope: client.scope,
    client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
  }, 201);
});

// =============================================================================
// Client Management (Admin)
// =============================================================================

oauthRoutes.get('/clients', async (c) => {
  // TODO: Add admin authentication
  const clients = listClients().map(client => ({
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    scope: client.scope,
    created_at: client.created_at,
  }));

  return c.json({ clients });
});

oauthRoutes.delete('/clients/:client_id', async (c) => {
  const clientId = c.req.param('client_id');

  // TODO: Add admin authentication
  const deleted = deleteClient(clientId);

  if (!deleted) {
    return c.json({ error: 'Client not found' }, 404);
  }

  return c.body(null, 204);
});

// =============================================================================
// Well-Known OAuth Metadata
// =============================================================================

oauthRoutes.get('/.well-known/oauth-authorization-server', async (c) => {
  const baseUrl = new URL(c.req.url).origin;

  return c.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    introspection_endpoint: `${baseUrl}/oauth/introspect`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: Object.keys({
      'projects:read': true,
      'projects:write': true,
      'runs:read': true,
      'runs:write': true,
      'agents:read': true,
      'agents:write': true,
      '*': true,
    }),
  });
});
