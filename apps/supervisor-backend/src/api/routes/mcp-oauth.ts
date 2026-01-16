/**
 * MCP OAuth Client Management Routes
 * Allows UI to create and manage OAuth clients for MCP access
 */

import { Hono } from 'hono';
import * as crypto from 'crypto';

const mcp = new Hono();

// Simple in-memory store for OAuth clients
// In production, this should be persisted to the database
interface OAuthClient {
  client_id: string;
  client_secret?: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: ('authorization_code' | 'refresh_token')[];
  scope: string;
  is_public: boolean;
  created_at: string;
}

const oauthClients = new Map<string, OAuthClient>();

function generateClientId(): string {
  return `mcp_${crypto.randomBytes(16).toString('base64url')}`;
}

function generateClientSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

// List all OAuth clients
mcp.get('/clients', (c) => {
  const clients = Array.from(oauthClients.values()).map(client => ({
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    scope: client.scope,
    is_public: client.is_public,
    created_at: client.created_at,
    // Don't expose client_secret in list
  }));
  return c.json({ clients });
});

// Create a new OAuth client
mcp.post('/clients', async (c) => {
  const body = await c.req.json();

  const clientId = generateClientId();
  const isPublic = body.is_public === true;
  const clientSecret = isPublic ? undefined : generateClientSecret();

  const client: OAuthClient = {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: body.client_name || 'MCP Client',
    redirect_uris: body.redirect_uris || ['http://localhost:8080/callback'],
    grant_types: body.grant_types || ['authorization_code', 'refresh_token'],
    scope: body.scope || '*',
    is_public: isPublic,
    created_at: new Date().toISOString(),
  };

  oauthClients.set(clientId, client);

  // Return full client info including secret (only shown once)
  return c.json({
    client_id: client.client_id,
    client_secret: client.client_secret, // Only returned on creation
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    scope: client.scope,
    is_public: client.is_public,
    created_at: client.created_at,
  }, 201);
});

// Get OAuth client details
mcp.get('/clients/:clientId', (c) => {
  const clientId = c.req.param('clientId');
  const client = oauthClients.get(clientId);

  if (!client) {
    return c.json({ error: 'Client not found' }, 404);
  }

  return c.json({
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    scope: client.scope,
    is_public: client.is_public,
    created_at: client.created_at,
  });
});

// Update OAuth client
mcp.put('/clients/:clientId', async (c) => {
  const clientId = c.req.param('clientId');
  const client = oauthClients.get(clientId);

  if (!client) {
    return c.json({ error: 'Client not found' }, 404);
  }

  const body = await c.req.json();

  if (body.client_name) {
    client.client_name = body.client_name;
  }
  if (body.redirect_uris) {
    client.redirect_uris = body.redirect_uris;
  }
  if (body.scope) {
    client.scope = body.scope;
  }

  oauthClients.set(clientId, client);

  return c.json({
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    scope: client.scope,
    is_public: client.is_public,
    created_at: client.created_at,
  });
});

// Delete OAuth client
mcp.delete('/clients/:clientId', (c) => {
  const clientId = c.req.param('clientId');

  if (!oauthClients.has(clientId)) {
    return c.json({ error: 'Client not found' }, 404);
  }

  oauthClients.delete(clientId);
  return c.json({ success: true });
});

// Regenerate client secret
mcp.post('/clients/:clientId/regenerate-secret', (c) => {
  const clientId = c.req.param('clientId');
  const client = oauthClients.get(clientId);

  if (!client) {
    return c.json({ error: 'Client not found' }, 404);
  }

  if (client.is_public) {
    return c.json({ error: 'Cannot regenerate secret for public client' }, 400);
  }

  client.client_secret = generateClientSecret();
  oauthClients.set(clientId, client);

  return c.json({
    client_id: client.client_id,
    client_secret: client.client_secret, // Return new secret
    client_name: client.client_name,
  });
});

// Get MCP server configuration info
mcp.get('/config', (c) => {
  const mcpPort = parseInt(process.env['MCP_SERVER_PORT'] ?? '3001', 10);
  const mcpHost = process.env['MCP_SERVER_HOST'] ?? 'localhost';

  return c.json({
    mcp_server_url: `http://${mcpHost}:${mcpPort}`,
    oauth_endpoints: {
      authorize: `http://${mcpHost}:${mcpPort}/oauth/authorize`,
      token: `http://${mcpHost}:${mcpPort}/oauth/token`,
      revoke: `http://${mcpHost}:${mcpPort}/oauth/revoke`,
    },
    mcp_endpoints: {
      metadata: `http://${mcpHost}:${mcpPort}/mcp`,
      tools: `http://${mcpHost}:${mcpPort}/mcp/tools`,
      sse: `http://${mcpHost}:${mcpPort}/mcp/sse`,
    },
    available_scopes: ['*', 'projects:read', 'projects:write', 'runs:read', 'runs:write', 'agents:read'],
  });
});

export { mcp };
