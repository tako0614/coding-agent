/**
 * HTTP Server with OAuth2 and MCP-over-SSE support
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { oauthRoutes, validateAccessToken } from './oauth/index.js';
import { ALL_TOOLS, getToolByName, setSupervisorBaseUrl } from './tools/index.js';

export interface HTTPServerOptions {
  port?: number;
  supervisorUrl?: string;
}

export function createHTTPServer(options: HTTPServerOptions = {}): Hono {
  const { supervisorUrl = 'http://localhost:3000' } = options;

  setSupervisorBaseUrl(supervisorUrl);

  const app = new Hono();

  // CORS
  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }));

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // OAuth routes
  app.route('/oauth', oauthRoutes);

  // MCP metadata
  app.get('/mcp', (c) => {
    return c.json({
      name: 'supervisor-mcp',
      version: '0.1.0',
      description: 'MCP Server for Supervisor Agent',
      tools: ALL_TOOLS.map(tool => ({
        name: tool.name,
        description: tool.description,
      })),
    });
  });

  // List tools
  app.get('/mcp/tools', (c) => {
    return c.json({
      tools: ALL_TOOLS.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(tool.inputSchema.shape || {}).map(([key, schema]) => [
              key,
              {
                type: 'string',
                description: (schema as { description?: string }).description,
              },
            ])
          ),
        },
      })),
    });
  });

  // Execute tool (requires authentication)
  app.post('/mcp/tools/:name', async (c) => {
    const toolName = c.req.param('name');
    const authHeader = c.req.header('Authorization');

    // Validate token
    let accessToken: string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const validated = validateAccessToken(token);
      if (validated) {
        accessToken = token;
      } else {
        return c.json({ error: 'invalid_token' }, 401);
      }
    }

    const tool = getToolByName(toolName);
    if (!tool) {
      return c.json({ error: 'Tool not found' }, 404);
    }

    try {
      const body = await c.req.json();
      const validatedInput = tool.inputSchema.parse(body);
      const result = await tool.handler(validatedInput, accessToken);
      return c.json({ result });
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 400);
    }
  });

  // MCP over SSE (Server-Sent Events)
  app.get('/mcp/sse', async (c) => {
    const authHeader = c.req.header('Authorization');

    // Validate token
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const validated = validateAccessToken(token);
      if (!validated) {
        return c.json({ error: 'invalid_token' }, 401);
      }
    }

    // Set up SSE headers
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    // Send initial connection message
    return c.body(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();

          // Send server info
          const serverInfo = {
            type: 'server_info',
            data: {
              name: 'supervisor-mcp',
              version: '0.1.0',
              tools: ALL_TOOLS.map(t => t.name),
            },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(serverInfo)}\n\n`));

          // Keep connection alive with heartbeat
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': heartbeat\n\n'));
            } catch {
              clearInterval(heartbeat);
            }
          }, 30000);
        },
      })
    );
  });

  return app;
}

export async function startHTTPServer(options: HTTPServerOptions = {}): Promise<void> {
  const { port = 3001 } = options;
  const app = createHTTPServer(options);

  console.log(`MCP Server starting on http://localhost:${port}`);
  console.log(`OAuth endpoints: http://localhost:${port}/oauth`);
  console.log(`MCP endpoints: http://localhost:${port}/mcp`);

  serve({
    fetch: app.fetch,
    port,
  });
}
