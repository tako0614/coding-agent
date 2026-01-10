/**
 * Supervisor Backend Server
 * OpenAI-compatible API + Run Management + WebSocket
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';

import { chat } from './api/routes/chat.js';
import { runs } from './api/routes/runs.js';
import { projects } from './api/routes/projects.js';
import { usage } from './api/routes/usage.js';
import { shell } from './api/routes/shell.js';
import { files } from './api/routes/files.js';
import { desktop } from './api/routes/desktop.js';
import { settings } from './api/routes/settings.js';
import { copilot } from './api/routes/copilot.js';
import { eventBus } from './services/event-bus.js';
import { getModelRouter } from './services/model-router.js';
import { copilotAPIManager } from './services/copilot-api-manager.js';
import { ptyService } from './services/pty-service.js';

// Check if running inside pkg bundle (snapshot filesystem)
// In ESM, we check process.pkg which is set by pkg runtime
const isPackaged = (process as NodeJS.Process & { pkg?: unknown }).pkg !== undefined;

const app = new Hono();

// Initialize model router with config from environment
getModelRouter({
  enableCopilot: process.env['ENABLE_COPILOT'] === 'true',
  copilotBaseUrl: process.env['COPILOT_API_URL'] ?? 'http://localhost:4141',
});

// Middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));
app.use('*', logger());

// MIME types for static files
const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

// Serve static files for WebUI
// Built frontend is placed in public/ui by vite build
// Dynamic import to avoid import.meta.url issues in CJS bundle
async function setupStaticFiles() {
  if (isPackaged) {
    console.log('[Server] Static file serving disabled (packaged mode)');
    return;
  }
  try {
    const fs = await import('fs');
    const pathModule = await import('path');

    // Custom static file handler with proper MIME types
    app.use('/*', async (c, next) => {
      const urlPath = c.req.path;

      // Skip API routes
      if (urlPath.startsWith('/api/') || urlPath.startsWith('/v1/')) {
        return next();
      }

      // Try to serve static file
      const filePath = pathModule.join('./public/ui', urlPath);

      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = pathModule.extname(filePath).toLowerCase();
          const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
          const content = fs.readFileSync(filePath);

          return new Response(content, {
            headers: {
              'Content-Type': mimeType,
              'Cache-Control': 'public, max-age=31536000',
            },
          });
        }
      } catch {
        // Fall through to next handler
      }

      return next();
    });

    console.log('[Server] Static file serving enabled');
  } catch (err) {
    console.log('[Server] Static file serving unavailable:', err);
  }
}
setupStaticFiles();

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// OpenAI-compatible endpoints
app.route('/v1/chat', chat);

// Models endpoint (OpenAI-compatible)
app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: [
      {
        id: 'supervisor-v1',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'supervisor-agent',
      },
    ],
  });
});

// Project management endpoints
app.route('/api/projects', projects);

// Run management endpoints
app.route('/api/runs', runs);

// Usage and model routing endpoints
app.route('/api/usage', usage);

// Shell execution endpoints
app.route('/api/shell', shell);

// File operations endpoints
app.route('/api/files', files);

// Settings endpoints
app.route('/api/settings', settings);

// Desktop control endpoints
app.route('/api/desktop', desktop);

// Copilot API management endpoints
app.route('/api/copilot', copilot);

// Legacy usage endpoint (for Copilot API compatibility)
app.get('/usage', async (c) => {
  const router = getModelRouter();
  const stats = await router.getUsageStats();

  if (stats.usage) {
    return c.json(stats.usage);
  }

  return c.json({
    premium_requests: {
      used: 0,
      limit: 1000,
      reset_at: new Date(Date.now() + 86400000).toISOString(),
    },
    embeddings: {
      used: 0,
      limit: 10000,
    },
  });
});

// SSE endpoint for streaming logs
app.get('/api/events', (c) => {
  const runId = c.req.query('run_id');

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const sendEvent = (data: unknown) => {
        const message = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(message));
      };

      // Send initial connection message
      sendEvent({ type: 'connected', timestamp: new Date().toISOString() });

      // Subscribe to events
      const unsubscribe = runId
        ? eventBus.subscribeToLogs(runId, sendEvent)
        : eventBus.subscribeToAll(sendEvent);

      // Handle client disconnect
      c.req.raw.signal?.addEventListener('abort', () => {
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// Get buffered logs for a run
app.get('/api/logs/:runId', (c) => {
  const runId = c.req.param('runId');
  const since = c.req.query('since');

  const logs = eventBus.getLogs(runId, since);

  return c.json({ logs });
});

// Error handling
app.onError((err, c) => {
  console.error('[Server] Error:', err);
  return c.json({
    error: {
      message: err.message,
      type: 'internal_error',
    },
  }, 500);
});

// Not found - serve index.html for SPA routes
app.notFound(async (c) => {
  const path = c.req.path;

  // API endpoints return JSON 404
  if (path.startsWith('/api/') || path.startsWith('/v1/')) {
    return c.json({
      error: {
        message: `Not found: ${path}`,
        type: 'not_found',
      },
    }, 404);
  }

  // SPA fallback: serve index.html for frontend routes
  try {
    const fs = await import('fs');
    const indexPath = './public/ui/index.html';
    if (fs.existsSync(indexPath)) {
      const html = fs.readFileSync(indexPath, 'utf-8');
      return c.html(html);
    }
  } catch {
    // Fall through to 404
  }

  return c.json({
    error: {
      message: `Not found: ${path}`,
      type: 'not_found',
    },
  }, 404);
});

// Start server
const port = parseInt(process.env['PORT'] ?? '3000', 10);

console.log(`
╔═══════════════════════════════════════════════════════════╗
║              Tako Agent Backend v0.1.0                    ║
╠═══════════════════════════════════════════════════════════╣
║  Web UI:                http://localhost:${port}/           ║
║  OpenAI-compatible API: http://localhost:${port}/v1/chat   ║
║  Run Management:        http://localhost:${port}/api/runs  ║
║  Health Check:          http://localhost:${port}/health    ║
╚═══════════════════════════════════════════════════════════╝
`);

const server = serve({
  fetch: app.fetch,
  port,
});

// Set up WebSocket server for PTY sessions
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url || '', `http://localhost:${port}`);
  const cwd = url.searchParams.get('cwd') || undefined;
  const cols = parseInt(url.searchParams.get('cols') || '80', 10);
  const rows = parseInt(url.searchParams.get('rows') || '24', 10);

  console.log(`[WebSocket] New PTY connection from ${req.socket.remoteAddress}`);
  ptyService.createSession(ws, { cwd, cols, rows });
});

// Handle upgrade requests
server.on('upgrade', (request: IncomingMessage, socket, head) => {
  const url = new URL(request.url || '', `http://localhost:${port}`);

  if (url.pathname === '/api/terminal') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

console.log(`║  Terminal WebSocket:      ws://localhost:${port}/api/terminal ║`);

// Initialize copilot-api manager (auto-start if enabled)
copilotAPIManager.initialize().catch((err) => {
  console.error('[Server] Failed to initialize copilot-api:', err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Server] Shutting down...');
  ptyService.cleanup();
  await copilotAPIManager.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Server] Shutting down...');
  ptyService.cleanup();
  await copilotAPIManager.shutdown();
  process.exit(0);
});

export { app };
