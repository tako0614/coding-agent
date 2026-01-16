/**
 * MCP Server for Supervisor Agent
 * Exposes supervisor functionality via Model Context Protocol
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { ALL_TOOLS, getToolByName, setSupervisorBaseUrl } from './tools/index.js';
import { validateAccessToken } from './oauth/store.js';

export interface MCPServerOptions {
  supervisorUrl?: string;
  accessToken?: string;
}

export function createMCPServer(options: MCPServerOptions = {}): Server {
  const { supervisorUrl = 'http://localhost:3000', accessToken } = options;

  // Configure supervisor URL
  setSupervisorBaseUrl(supervisorUrl);

  const server = new Server(
    {
      name: 'supervisor-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ALL_TOOLS.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: 'object' as const,
          properties: Object.fromEntries(
            Object.entries(tool.inputSchema.shape || {}).map(([key, schema]) => [
              key,
              {
                type: 'string',
                description: (schema as { description?: string }).description,
              },
            ])
          ),
          required: Object.keys(tool.inputSchema.shape || {}).filter(key => {
            const schema = (tool.inputSchema.shape as Record<string, { isOptional?: () => boolean }>)?.[key];
            return !schema?.isOptional?.();
          }),
        },
      })),
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const tool = getToolByName(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    try {
      // Validate input
      const validatedInput = tool.inputSchema.parse(args);

      // Execute tool with access token
      const result = await tool.handler(validatedInput, accessToken);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new McpError(ErrorCode.InternalError, error.message);
      }
      throw new McpError(ErrorCode.InternalError, 'Unknown error');
    }
  });

  return server;
}

/**
 * Run MCP server over stdio
 */
export async function runStdioServer(options: MCPServerOptions = {}): Promise<void> {
  const server = createMCPServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Handle shutdown
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });
}
