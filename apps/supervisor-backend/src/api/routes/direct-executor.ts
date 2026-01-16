/**
 * Direct Executor API Routes
 * Provides direct access to Claude Code and Codex without SupervisorAgent
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  directExecutorStore,
  type DirectExecutorType,
} from '../../services/direct-executor-store.js';
import { PathSecurityError } from '../../services/path-sandbox.js';
import type { WorkOrder } from '@supervisor/protocol';
import { createWorkOrderId, createRunId } from '@supervisor/protocol';
import type { ClaudeAgentMessage } from '@supervisor/executor-claude';
import type { CodexEvent } from '@supervisor/executor-codex';

const directExecutor = new Hono();

// --- Routes ---

/**
 * Create a new executor session
 */
directExecutor.post('/sessions', async (c) => {
  const body = await c.req.json().catch(() => ({}));

  const executor_type = body.executor_type;
  const cwd = body.cwd;

  // Validate
  if (!executor_type || (executor_type !== 'claude' && executor_type !== 'codex')) {
    return c.json({ error: { message: 'executor_type must be "claude" or "codex"' } }, 400);
  }
  if (!cwd || typeof cwd !== 'string' || cwd.trim().length === 0) {
    return c.json({ error: { message: 'cwd is required' } }, 400);
  }

  let session;
  try {
    session = directExecutorStore.create(executor_type as DirectExecutorType, cwd);
  } catch (error) {
    if (error instanceof PathSecurityError) {
      return c.json({
        error: {
          message: error.message,
          type: 'path_security_error',
          code: 'INVALID_PATH',
        },
      }, 400);
    }
    throw error;
  }

  return c.json({
    session_id: session.session_id,
    executor_type: session.executor_type,
    cwd: session.cwd,
    created_at: session.created_at,
  });
});

/**
 * List all sessions
 */
directExecutor.get('/sessions', async (c) => {
  const sessions = directExecutorStore.list();
  return c.json({ sessions });
});

/**
 * Get session details
 */
directExecutor.get('/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const session = directExecutorStore.getSession(sessionId);

  if (!session) {
    return c.json({ error: { message: 'Session not found' } }, 404);
  }

  return c.json({ session });
});

/**
 * Delete a session
 */
directExecutor.delete('/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const deleted = directExecutorStore.delete(sessionId);

  if (!deleted) {
    return c.json({ error: { message: 'Session not found' } }, 404);
  }

  return c.json({ success: true });
});

/**
 * Send a query to the executor and stream the response
 */
directExecutor.post('/sessions/:id/query', async (c) => {
  const sessionId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const prompt = body.prompt;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return c.json({ error: { message: 'prompt is required' } }, 400);
  }

  const entry = directExecutorStore.get(sessionId);
  if (!entry) {
    return c.json({ error: { message: 'Session not found' } }, 404);
  }

  const session = entry.session;

  // Create a minimal WorkOrder for the query
  const workOrder: WorkOrder = {
    order_id: createWorkOrderId(),
    run_id: createRunId(),
    task_kind: 'implement',
    repo: {
      path: session.cwd,
    },
    objective: prompt,
    acceptance_criteria: ['Complete the requested task'],
    verification: {
      commands: [],
    },
    tooling: {},
  };

  return streamSSE(c, async (stream) => {
    let eventId = 0;

    const sendEvent = async (type: string, data: unknown) => {
      await stream.writeSSE({
        id: String(eventId++),
        event: type,
        data: JSON.stringify(data),
      });
    };

    try {
      if (session.executor_type === 'claude') {
        const adapter = entry.claudeAdapter;
        if (!adapter) {
          await sendEvent('error', { message: 'Claude adapter not available' });
          return;
        }

        // Use executeStreaming for real-time updates
        for await (const message of adapter.executeStreaming(workOrder, {
          cwd: session.cwd,
          resumeSessionId: session.claude_session_id,
        })) {
          const msg = message as ClaudeAgentMessage;

          // Capture session ID from init message
          if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init' && msg.session_id) {
            directExecutorStore.updateSessionIds(sessionId, {
              claude_session_id: msg.session_id,
            });
          }

          // Capture session ID from result message
          if (msg.type === 'result' && 'session_id' in msg) {
            directExecutorStore.updateSessionIds(sessionId, {
              claude_session_id: msg.session_id,
            });
          }

          await sendEvent('message', {
            executor: 'claude',
            message: msg,
            timestamp: new Date().toISOString(),
          });
        }
      } else {
        const adapter = entry.codexAdapter;
        if (!adapter) {
          await sendEvent('error', { message: 'Codex adapter not available' });
          return;
        }

        // Use executeStreaming for real-time updates
        for await (const event of adapter.executeStreaming(workOrder, {
          cwd: session.cwd,
          resumeThreadId: session.codex_thread_id,
        })) {
          const evt = event as CodexEvent;

          // Capture thread ID from complete event
          if (evt.type === 'complete' && evt.thread_id) {
            directExecutorStore.updateSessionIds(sessionId, {
              codex_thread_id: evt.thread_id,
            });
          }

          await sendEvent('message', {
            executor: 'codex',
            message: evt,
            timestamp: new Date().toISOString(),
          });
        }
      }

      await sendEvent('done', { success: true });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await sendEvent('error', { message: errMsg });
    }
  });
});

export { directExecutor };
