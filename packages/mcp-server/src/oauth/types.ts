/**
 * OAuth2 Types for MCP Server
 */

export interface OAuthClient {
  client_id: string;
  client_secret?: string;  // Optional for public clients
  client_name: string;
  redirect_uris: string[];
  grant_types: ('authorization_code' | 'refresh_token')[];
  scope: string;
  created_at: string;
}

export interface OAuthAuthorizationCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  user_id: string;
  code_challenge?: string;
  code_challenge_method?: 'S256' | 'plain';
  expires_at: number;
  created_at: string;
}

export interface OAuthToken {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export interface OAuthStoredToken {
  access_token: string;
  refresh_token?: string;
  client_id: string;
  user_id: string;
  scope: string;
  expires_at: number;
  created_at: string;
}

export interface OAuthError {
  error: string;
  error_description?: string;
}

// Available scopes for MCP
export const OAUTH_SCOPES = {
  'projects:read': 'Read projects',
  'projects:write': 'Create and modify projects',
  'runs:read': 'Read runs and status',
  'runs:write': 'Create and control runs',
  'agents:read': 'Read agent information',
  'agents:write': 'Control agents',
  'settings:read': 'Read settings',
  'settings:write': 'Modify settings',
  '*': 'Full access',
} as const;

export type OAuthScope = keyof typeof OAUTH_SCOPES;
