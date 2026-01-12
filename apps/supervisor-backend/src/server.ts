/**
 * Supervisor Backend Server
 * OpenAI-compatible API + Run Management + WebSocket
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';

import { chat } from './api/routes/chat.js';
import { runs } from './api/routes/runs.js';
import { projects } from './api/routes/projects.js';
import { usage } from './api/routes/usage.js';
import { shell } from './api/routes/shell.js';
import { files } from './api/routes/files.js';
import { settings } from './api/routes/settings.js';
import { copilot } from './api/routes/copilot.js';
import { eventBus } from './services/event-bus.js';
import { getModelRouter } from './services/model-router.js';
import { copilotAPIManager } from './services/copilot-api-manager.js';
import { ptyService } from './services/pty-service.js';
import { db } from './services/db.js';
import { detectInterruptedRuns, stopAllCheckpointManagers } from './services/checkpoint.js';
import { logger } from './services/logger.js';
import { runStore } from './api/run-store.js';
import * as fs from 'fs';
import * as pathModule from 'path';
import { fileURLToPath } from 'url';

// Check if running inside pkg bundle (snapshot filesystem)
// In ESM, we check process.pkg which is set by pkg runtime
const isPackaged = (process as NodeJS.Process & { pkg?: unknown }).pkg !== undefined;

// Get the directory of this module for resolving static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = pathModule.dirname(__filename);
const publicUiPath = pathModule.resolve(__dirname, '..', 'public', 'ui');

const app = new Hono();

// Initialize model router with config from environment
getModelRouter({
  enableCopilot: process.env['ENABLE_COPILOT'] === 'true',
  copilotBaseUrl: process.env['COPILOT_API_URL'] ?? 'http://localhost:4141',
});

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // max requests per window

// Simple in-memory rate limiter with atomic increment
interface RateLimitRecord {
  count: number;
  resetAt: number;
}
const rateLimitStore = new Map<string, RateLimitRecord>();

/**
 * Atomically increment rate limit counter for a client
 * Returns the new count and whether the window was reset
 */
function incrementRateLimit(clientIp: string): { count: number; resetAt: number; wasReset: boolean } {
  const now = Date.now();
  const existing = rateLimitStore.get(clientIp);

  if (!existing || existing.resetAt < now) {
    // Create new record or reset expired one
    const newRecord: RateLimitRecord = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitStore.set(clientIp, newRecord);
    return { count: 1, resetAt: newRecord.resetAt, wasReset: true };
  }

  // Increment existing counter (single operation, no race)
  existing.count += 1;
  return { count: existing.count, resetAt: existing.resetAt, wasReset: false };
}

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitStore.entries()) {
    if (value.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

// Rate limiting middleware
app.use('*', async (c, next) => {
  // Skip rate limiting for static files
  if (!c.req.path.startsWith('/api/') && !c.req.path.startsWith('/v1/')) {
    return next();
  }

  // Get client identifier (prefer X-Forwarded-For for proxied requests)
  const clientIp = c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
                   c.req.header('X-Real-IP') ||
                   'unknown';

  // Atomically get and increment the rate limit
  const { count, resetAt } = incrementRateLimit(clientIp);

  // Set rate limit headers
  c.header('X-RateLimit-Limit', RATE_LIMIT_MAX_REQUESTS.toString());
  c.header('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX_REQUESTS - count).toString());
  c.header('X-RateLimit-Reset', Math.ceil(resetAt / 1000).toString());

  if (count > RATE_LIMIT_MAX_REQUESTS) {
    return c.json({
      error: {
        message: 'Too many requests, please try again later',
        type: 'rate_limit_exceeded',
      },
    }, 429);
  }

  return next();
});

// CORS configuration - restrict to localhost and configured origins
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173', // Vite dev server
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

// Allow additional origins from environment
const additionalOrigins = process.env['CORS_ALLOWED_ORIGINS'];
if (additionalOrigins) {
  allowedOrigins.push(...additionalOrigins.split(',').map(o => o.trim()));
}

// Request size limit middleware
const MAX_REQUEST_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

app.use('*', async (c, next) => {
  const contentLength = c.req.header('Content-Length');
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!Number.isNaN(size) && size > MAX_REQUEST_SIZE_BYTES) {
      return c.json({
        error: {
          message: `Request too large. Maximum size is ${MAX_REQUEST_SIZE_BYTES / 1024 / 1024}MB`,
          type: 'payload_too_large',
        },
      }, 413);
    }
  }
  return next();
});

app.use('*', cors({
  origin: (origin) => {
    // Allow requests with no origin (same-origin, curl, mobile apps)
    // Return the first allowed origin for CORS headers (not wildcard to avoid bypass)
    if (!origin) return allowedOrigins[0] ?? 'http://localhost:3000';
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) return origin;
    // For development, allow any localhost origin
    if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
      return origin;
    }
    return null; // Deny
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Last-Event-ID'],
  credentials: true,
}));
app.use('*', honoLogger());

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

// Serve static files for WebUI - synchronous setup
// Built frontend is placed in public/ui by vite build
if (!isPackaged) {
  // Custom static file handler with proper MIME types - registered FIRST
  app.use('/*', async (c, next) => {
    const urlPath = c.req.path;

    // Skip API routes
    if (urlPath.startsWith('/api/') || urlPath.startsWith('/v1/')) {
      return next();
    }

    // Try to serve static file
    const filePath = pathModule.join(publicUiPath, urlPath === '/' ? '/index.html' : urlPath);

    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = pathModule.extname(filePath).toLowerCase();
        const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
        const content = fs.readFileSync(filePath);

        return new Response(content, {
          headers: {
            'Content-Type': mimeType,
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000',
          },
        });
      }
    } catch {
      // Fall through to next handler
    }

    return next();
  });
  logger.info('Static file serving enabled', { path: publicUiPath });
}

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

// SSE endpoint for streaming logs with Last-Event-ID support
app.get('/api/events', (c) => {
  const runId = c.req.query('run_id');
  const lastEventIdHeader = c.req.header('Last-Event-ID');
  const lastEventId = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : undefined;

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const sendEvent = (data: unknown, eventId?: number) => {
        let message = '';
        if (eventId !== undefined) {
          message += `id: ${eventId}\n`;
        }
        message += `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(message));
      };

      // Send initial connection message
      sendEvent({ type: 'connected', timestamp: new Date().toISOString() });

      // Replay missed events if Last-Event-ID was provided
      if (runId && lastEventId !== undefined && !isNaN(lastEventId)) {
        const missedLogs = eventBus.getLogsSinceId(runId, lastEventId);
        if (missedLogs.length > 0) {
          sendEvent({
            type: 'replay_start',
            count: missedLogs.length,
            from_id: lastEventId,
          });
          for (const log of missedLogs) {
            sendEvent(log, log.id);
          }
          sendEvent({ type: 'replay_end' });
        }
      }

      // Subscribe to new events
      const unsubscribe = runId
        ? eventBus.subscribeToLogs(runId, (entry) => sendEvent(entry, entry.id))
        : eventBus.subscribeToAll((event) => {
            // Extract ID if it's a LogEntry
            const id = 'id' in event ? (event as { id?: number }).id : undefined;
            sendEvent(event, id);
          });

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

// Get orphaned sessions (interrupted runs with logs but no completed run)
app.get('/api/sessions/orphaned', (c) => {
  const sessions = eventBus.getOrphanedSessions();
  return c.json({ sessions });
});

// Delete orphaned session logs
app.delete('/api/sessions/orphaned/:runId', (c) => {
  const runId = c.req.param('runId');
  eventBus.deleteLogs(runId);
  return c.json({ deleted: true });
});

// Parallel sessions management
const getParallelSessionsStmt = db.prepare('SELECT sessions_json FROM parallel_sessions WHERE id = 1');
const updateParallelSessionsStmt = db.prepare(
  'UPDATE parallel_sessions SET sessions_json = ?, updated_at = ? WHERE id = 1'
);

// Get parallel sessions state
app.get('/api/sessions/parallel', (c) => {
  try {
    const row = getParallelSessionsStmt.get() as { sessions_json: string } | undefined;
    let sessions: unknown[] = [];
    if (row?.sessions_json) {
      try {
        const parsed = JSON.parse(row.sessions_json);
        sessions = Array.isArray(parsed) ? parsed : [];
      } catch (parseError) {
        logger.error('Failed to parse sessions JSON', { error: parseError instanceof Error ? parseError.message : String(parseError) });
        // Return empty array for malformed JSON
      }
    }
    return c.json({ sessions });
  } catch (error) {
    logger.error('Failed to get parallel sessions', { error: error instanceof Error ? error.message : String(error) });
    return c.json({ sessions: [] });
  }
});

// Save parallel sessions state
app.put('/api/sessions/parallel', async (c) => {
  try {
    const body = await c.req.json();
    const sessions = body.sessions || [];
    updateParallelSessionsStmt.run(JSON.stringify(sessions), new Date().toISOString());
    return c.json({ success: true });
  } catch (error) {
    logger.error('Failed to save parallel sessions', { error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: 'Failed to save sessions' }, 500);
  }
});

// Error handling
app.onError((err, c) => {
  logger.error('Server error', { error: err.message });
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
    logger.debug('API 404', { path });
    return c.json({
      error: {
        message: `Not found: ${path}`,
        type: 'not_found',
      },
    }, 404);
  }

  // SPA fallback: serve index.html for frontend routes
  try {
    const indexPath = pathModule.join(publicUiPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      const html = fs.readFileSync(indexPath, 'utf-8');
      return c.html(html);
    } else {
      logger.debug('SPA fallback failed: index.html not found', { indexPath });
    }
  } catch (err) {
    logger.debug('SPA fallback error', { error: err instanceof Error ? err.message : String(err) });
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

logger.info('Tako Agent Backend v0.1.0 starting', { port });
logger.info(`Web UI: http://localhost:${port}/`);
logger.info(`OpenAI-compatible API: http://localhost:${port}/v1/chat`);
logger.info(`Run Management: http://localhost:${port}/api/runs`);
logger.info(`Health Check: http://localhost:${port}/health`);

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

  logger.info('New PTY WebSocket connection', { remoteAddress: req.socket.remoteAddress });
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

logger.info(`Terminal WebSocket: ws://localhost:${port}/api/terminal`);

// Initialize copilot-api manager (auto-start if enabled)
copilotAPIManager.initialize().catch((err) => {
  logger.error('Failed to initialize copilot-api', { error: err instanceof Error ? err.message : String(err) });
});

// Detect and mark interrupted runs from previous server instance
try {
  const interruptedRuns = detectInterruptedRuns();
  if (interruptedRuns.length > 0) {
    logger.info('Detected interrupted runs from previous session', { count: interruptedRuns.length });
  }
} catch (err) {
  logger.error('Failed to detect interrupted runs', { error: err instanceof Error ? err.message : String(err) });
}

// Graceful shutdown flag to prevent double shutdown
let isShuttingDown = false;

/**
 * Graceful shutdown handler
 * Properly cleans up resources and marks interrupted runs
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress, ignoring signal', { signal });
    return;
  }
  isShuttingDown = true;

  logger.info('Graceful shutdown initiated', { signal });

  // Step 1: Stop accepting new connections
  try {
    server.close((err) => {
      if (err) {
        logger.error('Error closing HTTP server', { error: err.message });
      } else {
        logger.info('HTTP server closed');
      }
    });
  } catch (err) {
    logger.error('Failed to close HTTP server', { error: err instanceof Error ? err.message : String(err) });
  }

  // Step 2: Close WebSocket connections
  try {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, 'Server shutting down');
      }
    });
    wss.close();
    logger.info('WebSocket server closed');
  } catch (err) {
    logger.error('Failed to close WebSocket server', { error: err instanceof Error ? err.message : String(err) });
  }

  // Step 3: Stop checkpoint managers
  try {
    stopAllCheckpointManagers();
    logger.info('Checkpoint managers stopped');
  } catch (err) {
    logger.error('Failed to stop checkpoint managers', { error: err instanceof Error ? err.message : String(err) });
  }

  // Step 4: Clean up PTY sessions
  try {
    ptyService.cleanup();
    logger.info('PTY service cleaned up');
  } catch (err) {
    logger.error('Failed to cleanup PTY service', { error: err instanceof Error ? err.message : String(err) });
  }

  // Step 5: Shutdown copilot API manager
  try {
    await copilotAPIManager.shutdown();
    logger.info('Copilot API manager shutdown');
  } catch (err) {
    logger.error('Failed to shutdown copilot API manager', { error: err instanceof Error ? err.message : String(err) });
  }

  // Step 6: Close database connection
  try {
    db.close();
    logger.info('Database connection closed');
  } catch (err) {
    logger.error('Failed to close database', { error: err instanceof Error ? err.message : String(err) });
  }

  logger.info('Graceful shutdown completed');

  // Give time for logs to flush
  setTimeout(() => {
    process.exit(0);
  }, 100);
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', {
    error: err.message,
    stack: err.stack,
  });
  // Don't exit - let the process continue unless it's a fatal error
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

export { app };
