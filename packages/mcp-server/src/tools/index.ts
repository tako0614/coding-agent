/**
 * MCP Tools for Supervisor Agent
 * Exposes supervisor functionality as MCP tools
 */

import { z } from 'zod';

// Base URL for supervisor backend API
let supervisorBaseUrl = 'http://localhost:3000';

export function setSupervisorBaseUrl(url: string): void {
  supervisorBaseUrl = url;
}

/**
 * Helper to make authenticated API calls to supervisor
 */
async function supervisorFetch(
  path: string,
  options: RequestInit = {},
  accessToken?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  return fetch(`${supervisorBaseUrl}${path}`, {
    ...options,
    headers,
  });
}

// =============================================================================
// Tool Definitions
// =============================================================================

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: z.ZodSchema;
  handler: (input: unknown, accessToken?: string) => Promise<unknown>;
}

// -----------------------------------------------------------------------------
// Project Tools
// -----------------------------------------------------------------------------

export const listProjectsTool: MCPTool = {
  name: 'list_projects',
  description: 'List all projects in the supervisor',
  inputSchema: z.object({}),
  handler: async (_input, accessToken) => {
    const response = await supervisorFetch('/api/projects', {}, accessToken);
    if (!response.ok) {
      throw new Error(`Failed to list projects: ${response.statusText}`);
    }
    return response.json();
  },
};

export const createProjectTool: MCPTool = {
  name: 'create_project',
  description: 'Create a new project',
  inputSchema: z.object({
    name: z.string().describe('Project name'),
    description: z.string().optional().describe('Project description'),
    repo_path: z.string().describe('Path to the repository'),
  }),
  handler: async (input, accessToken) => {
    const response = await supervisorFetch('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }, accessToken);
    if (!response.ok) {
      throw new Error(`Failed to create project: ${response.statusText}`);
    }
    return response.json();
  },
};

export const getProjectTool: MCPTool = {
  name: 'get_project',
  description: 'Get project details by ID',
  inputSchema: z.object({
    project_id: z.string().describe('Project ID'),
  }),
  handler: async (input: { project_id: string }, accessToken) => {
    const response = await supervisorFetch(`/api/projects/${input.project_id}`, {}, accessToken);
    if (!response.ok) {
      throw new Error(`Failed to get project: ${response.statusText}`);
    }
    return response.json();
  },
};

export const deleteProjectTool: MCPTool = {
  name: 'delete_project',
  description: 'Delete a project',
  inputSchema: z.object({
    project_id: z.string().describe('Project ID'),
  }),
  handler: async (input: { project_id: string }, accessToken) => {
    const response = await supervisorFetch(`/api/projects/${input.project_id}`, {
      method: 'DELETE',
    }, accessToken);
    if (!response.ok) {
      throw new Error(`Failed to delete project: ${response.statusText}`);
    }
    return { success: true };
  },
};

// -----------------------------------------------------------------------------
// Run Tools
// -----------------------------------------------------------------------------

export const listRunsTool: MCPTool = {
  name: 'list_runs',
  description: 'List runs for a project',
  inputSchema: z.object({
    project_id: z.string().describe('Project ID'),
  }),
  handler: async (input: { project_id: string }, accessToken) => {
    const response = await supervisorFetch(`/api/projects/${input.project_id}/runs`, {}, accessToken);
    if (!response.ok) {
      throw new Error(`Failed to list runs: ${response.statusText}`);
    }
    return response.json();
  },
};

export const createRunTool: MCPTool = {
  name: 'create_run',
  description: 'Create a new run (start an agent)',
  inputSchema: z.object({
    project_id: z.string().describe('Project ID'),
    goal: z.string().describe('Goal/task for the agent'),
    mode: z.enum(['agent', 'codex_only', 'claude_only']).optional().describe('Execution mode'),
  }),
  handler: async (input: { project_id: string; goal: string; mode?: string }, accessToken) => {
    const response = await supervisorFetch(`/api/projects/${input.project_id}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        goal: input.goal,
        mode: input.mode,
      }),
    }, accessToken);
    if (!response.ok) {
      throw new Error(`Failed to create run: ${response.statusText}`);
    }
    return response.json();
  },
};

export const getRunTool: MCPTool = {
  name: 'get_run',
  description: 'Get run details and status',
  inputSchema: z.object({
    run_id: z.string().describe('Run ID'),
  }),
  handler: async (input: { run_id: string }, accessToken) => {
    const response = await supervisorFetch(`/api/runs/${input.run_id}`, {}, accessToken);
    if (!response.ok) {
      throw new Error(`Failed to get run: ${response.statusText}`);
    }
    return response.json();
  },
};

export const cancelRunTool: MCPTool = {
  name: 'cancel_run',
  description: 'Cancel a running agent',
  inputSchema: z.object({
    run_id: z.string().describe('Run ID'),
  }),
  handler: async (input: { run_id: string }, accessToken) => {
    const response = await supervisorFetch(`/api/runs/${input.run_id}/cancel`, {
      method: 'POST',
    }, accessToken);
    if (!response.ok) {
      throw new Error(`Failed to cancel run: ${response.statusText}`);
    }
    return response.json();
  },
};

export const sendMessageTool: MCPTool = {
  name: 'send_message',
  description: 'Send a message to a running agent',
  inputSchema: z.object({
    run_id: z.string().describe('Run ID'),
    message: z.string().describe('Message content'),
  }),
  handler: async (input: { run_id: string; message: string }, accessToken) => {
    const response = await supervisorFetch(`/api/runs/${input.run_id}/message`, {
      method: 'POST',
      body: JSON.stringify({ content: input.message }),
    }, accessToken);
    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.statusText}`);
    }
    return response.json();
  },
};

// -----------------------------------------------------------------------------
// Agent Tools
// -----------------------------------------------------------------------------

export const listAgentsTool: MCPTool = {
  name: 'list_agents',
  description: 'List all active agents',
  inputSchema: z.object({}),
  handler: async (_input, accessToken) => {
    const response = await supervisorFetch('/api/agents', {}, accessToken);
    if (!response.ok) {
      throw new Error(`Failed to list agents: ${response.statusText}`);
    }
    return response.json();
  },
};

// -----------------------------------------------------------------------------
// All Tools
// -----------------------------------------------------------------------------

export const ALL_TOOLS: MCPTool[] = [
  // Projects
  listProjectsTool,
  createProjectTool,
  getProjectTool,
  deleteProjectTool,
  // Runs
  listRunsTool,
  createRunTool,
  getRunTool,
  cancelRunTool,
  sendMessageTool,
  // Agents
  listAgentsTool,
];

export function getToolByName(name: string): MCPTool | undefined {
  return ALL_TOOLS.find(tool => tool.name === name);
}
