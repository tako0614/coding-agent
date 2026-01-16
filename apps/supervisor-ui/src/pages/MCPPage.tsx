import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Key,
  Plus,
  Trash2,
  Copy,
  RefreshCw,
  ExternalLink,
  Check,
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  fetchMCPClients,
  fetchMCPConfig,
  createMCPClient,
  deleteMCPClient,
  regenerateMCPClientSecret,
  type MCPOAuthClient,
} from '../lib/api';
import clsx from 'clsx';

export default function MCPPage() {
  const { t: _t } = useTranslation();
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newClientRedirectUri, setNewClientRedirectUri] = useState('http://localhost:8080/callback');
  const [newClientScope, setNewClientScope] = useState('*');
  const [isPublic, setIsPublic] = useState(false);
  const [newlyCreatedClient, setNewlyCreatedClient] = useState<MCPOAuthClient | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  const { data: clientsData, isLoading: isLoadingClients } = useQuery({
    queryKey: ['mcp-clients'],
    queryFn: fetchMCPClients,
  });

  const { data: configData } = useQuery({
    queryKey: ['mcp-config'],
    queryFn: fetchMCPConfig,
  });

  const createMutation = useMutation({
    mutationFn: createMCPClient,
    onSuccess: (client) => {
      setNewlyCreatedClient(client);
      setShowCreateForm(false);
      setNewClientName('');
      queryClient.invalidateQueries({ queryKey: ['mcp-clients'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteMCPClient,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-clients'] });
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: regenerateMCPClientSecret,
    onSuccess: (client) => {
      setNewlyCreatedClient(client);
      queryClient.invalidateQueries({ queryKey: ['mcp-clients'] });
    },
  });

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleCreate = () => {
    createMutation.mutate({
      client_name: newClientName,
      redirect_uris: [newClientRedirectUri],
      scope: newClientScope,
      is_public: isPublic,
    });
  };

  const toggleSecretVisibility = (clientId: string) => {
    setShowSecrets(prev => ({ ...prev, [clientId]: !prev[clientId] }));
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Key size={28} />
            MCP OAuth Clients
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Manage OAuth clients for MCP (Model Context Protocol) access
          </p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
        >
          <Plus size={18} />
          Create Client
        </button>
      </div>

      {/* MCP Server Config */}
      {configData && (
        <div className="bg-slate-100 rounded-lg p-4 mb-6">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">MCP Server Configuration</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-slate-500 mb-1">Server URL</div>
              <div className="font-mono bg-white px-2 py-1 rounded flex items-center justify-between">
                {configData.mcp_server_url}
                <button
                  onClick={() => handleCopy(configData.mcp_server_url, 'server-url')}
                  className="text-slate-400 hover:text-slate-600"
                >
                  {copiedField === 'server-url' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
            <div>
              <div className="text-slate-500 mb-1">OAuth Authorize</div>
              <div className="font-mono bg-white px-2 py-1 rounded flex items-center justify-between">
                {configData.oauth_endpoints.authorize}
                <button
                  onClick={() => handleCopy(configData.oauth_endpoints.authorize, 'oauth-authorize')}
                  className="text-slate-400 hover:text-slate-600"
                >
                  {copiedField === 'oauth-authorize' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
            <div>
              <div className="text-slate-500 mb-1">OAuth Token</div>
              <div className="font-mono bg-white px-2 py-1 rounded flex items-center justify-between">
                {configData.oauth_endpoints.token}
                <button
                  onClick={() => handleCopy(configData.oauth_endpoints.token, 'oauth-token')}
                  className="text-slate-400 hover:text-slate-600"
                >
                  {copiedField === 'oauth-token' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
            <div>
              <div className="text-slate-500 mb-1">Available Scopes</div>
              <div className="font-mono bg-white px-2 py-1 rounded">
                {configData.available_scopes.join(', ')}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Newly Created Client Alert */}
      {newlyCreatedClient?.client_secret && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
          <h3 className="font-semibold text-yellow-800 mb-2">
            Client Secret (Save this now - it won't be shown again!)
          </h3>
          <div className="font-mono bg-white px-3 py-2 rounded border border-yellow-300 flex items-center justify-between">
            <span className="break-all">
              {showSecrets['new'] ? newlyCreatedClient.client_secret : '•'.repeat(32)}
            </span>
            <div className="flex items-center gap-2 ml-4">
              <button
                onClick={() => toggleSecretVisibility('new')}
                className="text-slate-400 hover:text-slate-600"
              >
                {showSecrets['new'] ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
              <button
                onClick={() => handleCopy(newlyCreatedClient.client_secret!, 'new-secret')}
                className="text-slate-400 hover:text-slate-600"
              >
                {copiedField === 'new-secret' ? <Check size={16} /> : <Copy size={16} />}
              </button>
            </div>
          </div>
          <div className="mt-2 text-sm text-yellow-700">
            Client ID: <span className="font-mono">{newlyCreatedClient.client_id}</span>
            <button
              onClick={() => handleCopy(newlyCreatedClient.client_id, 'new-client-id')}
              className="ml-2 text-yellow-600 hover:text-yellow-800"
            >
              {copiedField === 'new-client-id' ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <button
            onClick={() => setNewlyCreatedClient(null)}
            className="mt-3 text-sm text-yellow-600 hover:text-yellow-800"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Create Form Modal */}
      {showCreateForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold mb-4">Create OAuth Client</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Client Name
                </label>
                <input
                  type="text"
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                  placeholder="My MCP Client"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Redirect URI
                </label>
                <input
                  type="text"
                  value={newClientRedirectUri}
                  onChange={(e) => setNewClientRedirectUri(e.target.value)}
                  placeholder="http://localhost:8080/callback"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Scope
                </label>
                <select
                  value={newClientScope}
                  onChange={(e) => setNewClientScope(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  <option value="*">All (*)</option>
                  <option value="projects:read">Projects Read Only</option>
                  <option value="projects:read projects:write">Projects Read/Write</option>
                  <option value="runs:read">Runs Read Only</option>
                  <option value="runs:read runs:write">Runs Read/Write</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is-public"
                  checked={isPublic}
                  onChange={(e) => setIsPublic(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <label htmlFor="is-public" className="text-sm text-slate-700">
                  Public client (no client secret)
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowCreateForm(false)}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!newClientName || createMutation.isPending}
                className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
              >
                {createMutation.isPending ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clients List */}
      {isLoadingClients ? (
        <div className="text-center py-8 text-slate-500">Loading clients...</div>
      ) : clientsData?.clients.length === 0 ? (
        <div className="text-center py-12">
          <Key className="mx-auto text-slate-400 mb-4" size={48} />
          <h3 className="text-lg font-medium text-slate-700 mb-2">No OAuth Clients</h3>
          <p className="text-slate-500 mb-4">Create an OAuth client to allow AI agents to access the supervisor via MCP.</p>
          <button
            onClick={() => setShowCreateForm(true)}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            Create First Client
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {clientsData?.clients.map((client) => (
            <div
              key={client.client_id}
              className="bg-white rounded-lg border border-slate-200 p-4"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-slate-800">{client.client_name}</h3>
                  <div className="text-sm text-slate-500 mt-1">
                    <span className="font-mono">{client.client_id}</span>
                    <button
                      onClick={() => handleCopy(client.client_id, `client-${client.client_id}`)}
                      className="ml-2 text-slate-400 hover:text-slate-600"
                    >
                      {copiedField === `client-${client.client_id}` ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!client.is_public && (
                    <button
                      onClick={() => regenerateMutation.mutate(client.client_id)}
                      disabled={regenerateMutation.isPending}
                      className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                      title="Regenerate Secret"
                    >
                      <RefreshCw size={18} className={regenerateMutation.isPending ? 'animate-spin' : ''} />
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (confirm('Are you sure you want to delete this client?')) {
                        deleteMutation.mutate(client.client_id);
                      }
                    }}
                    className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    title="Delete Client"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <div className="text-slate-500">Type</div>
                  <div className={clsx(
                    'font-medium',
                    client.is_public ? 'text-blue-600' : 'text-green-600'
                  )}>
                    {client.is_public ? 'Public' : 'Confidential'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Scope</div>
                  <div className="font-mono text-slate-700">{client.scope}</div>
                </div>
                <div>
                  <div className="text-slate-500">Redirect URIs</div>
                  <div className="font-mono text-slate-700 truncate">{client.redirect_uris[0]}</div>
                </div>
                <div>
                  <div className="text-slate-500">Created</div>
                  <div className="text-slate-700">
                    {new Date(client.created_at).toLocaleDateString()}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Usage Instructions */}
      <div className="mt-8 bg-slate-50 rounded-lg p-4">
        <h3 className="font-semibold text-slate-700 mb-2">How to Use</h3>
        <ol className="list-decimal list-inside text-sm text-slate-600 space-y-2">
          <li>Create an OAuth client above and save the client ID and secret</li>
          <li>Start the MCP server: <code className="bg-white px-2 py-0.5 rounded">supervisor-mcp --http --port=3001</code></li>
          <li>Configure your MCP client (Claude Desktop, etc.) to use the OAuth endpoints</li>
          <li>Authorize your client using the OAuth flow to get an access token</li>
          <li>Use the access token to call MCP tools via the MCP server</li>
        </ol>
        <div className="mt-4">
          <a
            href="https://modelcontextprotocol.io/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-600 hover:text-primary-700 text-sm flex items-center gap-1"
          >
            MCP Documentation <ExternalLink size={14} />
          </a>
        </div>
      </div>
    </div>
  );
}
