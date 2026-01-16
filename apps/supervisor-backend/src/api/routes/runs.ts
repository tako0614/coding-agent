/**
 * Run management API routes
 *
 * Uses Supervisor Agent pattern with GPT orchestrating Claude/Codex workers.
 */

import { Hono } from 'hono';
import { createRunId } from '@supervisor/protocol';
import {
  CreateRunRequestSchema,
  SendMessageRequestSchema,
  type RunListResponse,
  type ConversationResponse,
  type ChatMessageResponse,
} from '../types.js';
import { runStore } from '../run-store.js';
import { runSimplifiedSupervisor, type SimplifiedSupervisorStateType } from '../../graph/index.js';
import { agentStore, type SupervisorState } from '../../supervisor/index.js';
import {
  specAgentStore,
  getConversation,
  getThreadsForRun,
  getActiveThread,
  createThread,
  branchFromMessage,
  switchThread,
  getThreadMessages,
  getConversationTree,
} from '../../spec-agent/index.js';
import { logger } from '../../services/logger.js';
import { validateRepoPath, PathSecurityError } from '../../services/path-sandbox.js';
import { withRunLock, LockTimeoutError } from '../../services/run-lock.js';
import { eventBus } from '../../services/event-bus.js';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Create a standardized error response
 */
function errorResponse(
  c: Context,
  statusCode: ContentfulStatusCode,
  message: string,
  type?: string,
  details?: unknown
): Response {
  const errorBody = {
    error: {
      message,
      type: type ?? undefined,
      details: details ?? undefined,
    },
  };

  return c.json(errorBody, statusCode);
}

/**
 * Convert SupervisorState to SimplifiedSupervisorStateType
 */
function convertToSimplifiedState(finalState: SupervisorState): SimplifiedSupervisorStateType {
  return {
    run_id: finalState.run_id,
    status: finalState.phase === 'completed' ? 'completed' : 'failed',
    user_goal: finalState.user_goal,
    repo_path: finalState.repo_path,
    project_id: undefined, // Not available in SupervisorState
    created_at: finalState.created_at,
    updated_at: finalState.updated_at,
    final_summary: finalState.final_summary,
    error: finalState.error,
    reports: finalState.completed_tasks
      .filter(t => t.report)
      .map(t => t.report!),
    supervisor_thinking: undefined,
    worker_pool: undefined,
  };
}

const runs = new Hono();

/**
 * GET /api/runs
 * List all runs with pagination support
 * Query params:
 *   - page: page number (1-indexed, default: 1)
 *   - pageSize: items per page (default: 20, max: 100)
 */
/** Maximum page size allowed */
const MAX_PAGE_SIZE = 100;

runs.get('/', (c) => {
  logger.debug('GET /api/runs called');

  // Parse and validate pagination query params
  const rawPage = parseInt(c.req.query('page') || '1', 10);
  const rawPageSize = parseInt(c.req.query('pageSize') || '20', 10);

  // Sanitize: ensure positive integers within bounds
  const page = Number.isNaN(rawPage) ? 1 : Math.max(1, rawPage);
  const pageSize = Number.isNaN(rawPageSize) ? 20 : Math.max(1, Math.min(MAX_PAGE_SIZE, rawPageSize));

  const result = runStore.list({ page, pageSize });

  logger.debug('GET /api/runs returning runs', {
    count: result.runs.length,
    page: result.pagination.page,
    totalCount: result.pagination.totalCount,
  });

  const response: RunListResponse = {
    runs: result.runs,
    total: result.pagination.totalCount,
    pagination: result.pagination,
  };
  return c.json(response);
});

/**
 * POST /api/runs
 * Create and start a new run with Supervisor Agent or Spec Agent
 */
runs.post('/', async (c) => {
  logger.info('POST /api/runs received');
  try {
    const body = await c.req.json();
    logger.debug('Request body', { body });
    const parsed = CreateRunRequestSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(c, 400, 'Invalid request body', 'validation_error', parsed.error.errors);
    }

    const request = parsed.data;
    const runId = createRunId();
    const mode = request.mode || 'implementation';

    // Validate repo_path for security (prevent directory traversal, symlink attacks)
    let validatedRepoPath: string;
    try {
      validatedRepoPath = validateRepoPath(request.repo_path);
    } catch (err) {
      const message = err instanceof PathSecurityError
        ? `Invalid repository path: ${err.message}`
        : 'Invalid repository path';
      logger.warn('Repository path validation failed', {
        repoPath: request.repo_path,
        error: message,
      });
      return c.json({
        error: {
          message,
        },
      }, 400);
    }

    logger.info('Creating run', { runId, projectId: request.project_id ?? 'none', mode, repoPath: validatedRepoPath });

    if (mode === 'spec') {
      // Spec mode: Create SpecAgent for chat-based specification
      try {
        specAgentStore.create({
          runId,
          repoPath: validatedRepoPath,
        });

        // Track as a spec mode run (no promise since it's chat-based)
        runStore.setMode(runId, 'spec');

        return c.json({
          run_id: runId,
          mode: 'spec',
          status: 'ready',
          project_id: request.project_id,
          message: 'Spec Agent created. Send messages to /api/runs/:id/message to chat.',
        }, 201);
      } catch (error) {
        logger.error('Error creating SpecAgent', { runId, error: error instanceof Error ? error.message : String(error) });
        return c.json({
          error: {
            message: error instanceof Error ? error.message : 'Failed to create SpecAgent',
          },
        }, 500);
      }
    }

    // Implementation mode: Use Supervisor Agent
    // IMPORTANT: Insert run record FIRST so logs can be saved (foreign key constraint)
    // We create a deferred promise that we resolve/reject when the actual run completes
    let resolveRun: (value: SimplifiedSupervisorStateType) => void;
    let rejectRun: (reason: unknown) => void;
    const deferredPromise = new Promise<SimplifiedSupervisorStateType>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });

    // Register the run FIRST (inserts DB record)
    runStore.setRunning(runId, deferredPromise, request.goal, request.project_id, validatedRepoPath, 'implementation');

    // NOW start the supervisor (logs can be saved because run record exists)
    const runPromise = runSimplifiedSupervisor({
      userGoal: request.goal,
      repoPath: validatedRepoPath,
      runId,
      projectId: request.project_id,
    });

    runPromise.then(finalState => {
      resolveRun!(finalState);
      try {
        runStore.set(runId, finalState);
        logger.info('Run completed', { runId, status: finalState.status });
      } catch (storeError) {
        logger.error('Failed to store run result', { runId, error: storeError instanceof Error ? storeError.message : String(storeError) });
        // Try to mark as failed if set() failed
        try {
          runStore.markFailed(runId, 'Failed to store run result');
        } catch {
          // Last resort: just log the error
          logger.error('Failed to mark run as failed after store error', { runId });
        }
      }
    }).catch(error => {
      rejectRun!(error);
      logger.error('Run failed', { runId, error: error instanceof Error ? error.message : String(error) });
      // Store error state using markFailed to properly cleanup tracking
      const errorMsg = error instanceof Error ? error.message : String(error);
      try {
        runStore.markFailed(runId, errorMsg);
      } catch (markError) {
        logger.error('Failed to mark run as failed', { runId, error: markError instanceof Error ? markError.message : String(markError) });
      }
    });

    return c.json({
      run_id: runId,
      mode: 'implementation',
      status: 'pending',
      project_id: request.project_id,
      message: 'Run started with Supervisor Agent',
    }, 202);
  } catch (error) {
    logger.error('Error creating run', { error: error instanceof Error ? error.message : String(error) });
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Internal server error',
      },
    }, 500);
  }
});

/**
 * GET /api/runs/:id
 * Get a specific run
 */
runs.get('/:id', async (c) => {
  const runId = c.req.param('id');

  // Check if run is still executing
  if (runStore.isRunning(runId)) {
    return c.json({
      run_id: runId,
      status: 'running',
      message: 'Run is still executing',
    });
  }

  const state = runStore.get(runId);

  if (!state) {
    return c.json({
      error: {
        message: `Run ${runId} not found`,
      },
    }, 404);
  }

  return c.json(runStore.toResponse(state));
});

/**
 * GET /api/runs/:id/logs
 * Get logs for a run (from database)
 */
runs.get('/:id/logs', (c) => {
  const runId = c.req.param('id');
  const since = c.req.query('since');

  // Load logs from database via eventBus
  const logs = eventBus.getLogs(runId, since || undefined);

  return c.json({ logs });
});

/**
 * GET /api/runs/:id/report
 * Get the final report for a run
 */
runs.get('/:id/report', (c) => {
  const runId = c.req.param('id');
  const state = runStore.get(runId);

  if (!state) {
    return c.json({
      error: {
        message: `Run ${runId} not found`,
      },
    }, 404);
  }

  if (!state.final_summary) {
    return c.json({
      error: {
        message: `Run ${runId} has not completed yet`,
      },
    }, 404);
  }

  return c.text(state.final_summary, 200, {
    'Content-Type': 'text/markdown',
  });
});

/**
 * DELETE /api/runs/:id
 * Delete a run
 */
runs.delete('/:id', (c) => {
  const runId = c.req.param('id');

  if (runStore.isRunning(runId)) {
    return c.json({
      error: {
        message: `Cannot delete running run ${runId}`,
      },
    }, 409);
  }

  const deleted = runStore.delete(runId);

  if (!deleted) {
    return c.json({
      error: {
        message: `Run ${runId} not found`,
      },
    }, 404);
  }

  // Clean up agent instance to prevent memory leak
  agentStore.delete(runId);

  return c.json({ message: `Run ${runId} deleted` });
});

/**
 * GET /api/runs/:id/workers
 * Get worker pool status for a run
 */
runs.get('/:id/workers', (c) => {
  const runId = c.req.param('id');

  if (runStore.has(runId)) {
    if (runStore.isRunning(runId)) {
      return c.json({
        error: {
          message: `Run ${runId} is still executing`,
        },
      }, 202);
    }

    const workerPool = runStore.getWorkerPool(runId);
    if (workerPool) {
      return c.json(workerPool);
    }
  }

  return c.json({
    error: {
      message: `Worker pool not found for run ${runId}`,
    },
  }, 404);
});

/**
 * POST /api/runs/:id/restart
 * Restart a failed or completed run
 */
runs.post('/:id/restart', async (c) => {
  const runId = c.req.param('id');
  logger.info('POST /api/runs/:id/restart received', { runId });

  try {
    // Use lock to prevent concurrent restart/cancel operations
    return await withRunLock(runId, 'restart', async () => {
      // Check if run is currently running
      if (runStore.isRunning(runId)) {
        return c.json({
          error: {
            message: `Run ${runId} is still running, cannot restart`,
          },
        }, 409);
      }

      // Get the agent instance
      const agent = agentStore.get(runId);
      if (!agent) {
        return c.json({
          error: {
            message: `Agent instance not found for run ${runId}. Cannot restart - please create a new run.`,
          },
        }, 404);
      }

      // Check if agent can be restarted
      if (!agent.canRestart()) {
        return c.json({
          error: {
            message: `Run ${runId} cannot be restarted (current state doesn't allow restart)`,
          },
        }, 400);
      }

      // Get the stored state to preserve project_id
      const storedState = runStore.get(runId);
      const projectId = storedState?.project_id;

      // Start restart in background
  const restartPromise: Promise<SimplifiedSupervisorStateType> = agent.restart().then(finalState => {
    // Convert SupervisorState to SimplifiedSupervisorStateType
    let simplifiedState: SimplifiedSupervisorStateType;
    try {
      simplifiedState = convertToSimplifiedState(finalState);
      // Update run store with new state
      runStore.set(runId, simplifiedState);
      logger.info('Run restart completed', { runId, phase: finalState.phase });
    } catch (storeError) {
      logger.error('Failed to store restart result', { runId, error: storeError instanceof Error ? storeError.message : String(storeError) });
      try {
        runStore.markFailed(runId, 'Failed to store restart result');
      } catch {
        // Ignore secondary errors
      }
      // Return a failed state instead of throwing
      return {
        run_id: runId,
        status: 'failed' as const,
        user_goal: agent.getState().user_goal,
        repo_path: agent.getState().repo_path,
        project_id: projectId,
        supervisor_thinking: undefined,
        final_summary: undefined,
        worker_pool: undefined,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error: 'Failed to store restart result',
        reports: [],
      };
    }
    return simplifiedState;
  }).catch(error => {
    logger.error('Run restart failed', { runId, error: error instanceof Error ? error.message : String(error) });
    const errorMsg = error instanceof Error ? error.message : String(error);
    try {
      runStore.markFailed(runId, errorMsg);
    } catch (markError) {
      logger.error('Failed to mark restart as failed', { runId, error: markError instanceof Error ? markError.message : String(markError) });
    }
    // Return a failed state instead of throwing to avoid unhandled promise rejection
    return {
      run_id: runId,
      status: 'failed' as const,
      user_goal: agent.getState().user_goal,
      repo_path: agent.getState().repo_path,
      project_id: projectId,
      supervisor_thinking: undefined,
      final_summary: undefined,
      worker_pool: undefined,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      error: errorMsg,
      reports: [],
    };
  });

      // Track as running
      runStore.setRunning(runId, restartPromise, agent.getState().user_goal);

      return c.json({
        run_id: runId,
        status: 'restarting',
        message: 'Run is being restarted',
      }, 202);
    }); // End of withRunLock
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return c.json({
        error: {
          message: `Run ${runId} is currently being modified by another operation`,
          type: 'lock_timeout',
        },
      }, 409);
    }
    throw error;
  }
});

/**
 * POST /api/runs/:id/cancel
 * Cancel a running run
 */
runs.post('/:id/cancel', async (c) => {
  const runId = c.req.param('id');
  logger.info('POST /api/runs/:id/cancel received', { runId });

  try {
    // Use lock to prevent concurrent restart/cancel operations
    return await withRunLock(runId, 'cancel', async () => {
      const agent = agentStore.get(runId);
      if (!agent) {
        return c.json({
          error: {
            message: `Agent instance not found for run ${runId}`,
          },
        }, 404);
      }

      agent.cancel('Cancelled by user via API');

      return c.json({
        run_id: runId,
        status: 'cancelled',
        message: 'Run has been cancelled',
      });
    });
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return c.json({
        error: {
          message: `Run ${runId} is currently being modified by another operation`,
          type: 'lock_timeout',
        },
      }, 409);
    }
    throw error;
  }
});

/**
 * POST /api/runs/:id/message
 * Send a message to a spec mode run
 */
runs.post('/:id/message', async (c) => {
  const runId = c.req.param('id');
  logger.info('POST /api/runs/:id/message received', { runId });

  // Check if this is a spec mode run
  const mode = runStore.getMode(runId);
  if (mode !== 'spec') {
    return c.json({
      error: {
        message: `Run ${runId} is not in spec mode. Use implementation mode APIs instead.`,
      },
    }, 400);
  }

  // Get or create SpecAgent
  const agent = specAgentStore.get(runId);
  if (!agent) {
    return c.json({
      error: {
        message: `SpecAgent not found for run ${runId}. The run may have been created in a different session.`,
      },
    }, 404);
  }

  try {
    const body = await c.req.json();
    const parsed = SendMessageRequestSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(c, 400, 'Invalid request body', 'validation_error', parsed.error.errors);
    }

    const { message } = parsed.data;
    logger.debug('Processing spec message', { runId, messageLength: message.length });

    const response = await agent.chat(message);

    const result: ChatMessageResponse = {
      message: response.message,
      tool_calls: response.tool_calls,
      completed: response.completed,
      completion_summary: response.completionSummary,
    };

    return c.json(result);
  } catch (error) {
    logger.error('Error processing spec message', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to process message',
      },
    }, 500);
  }
});

/**
 * GET /api/runs/:id/conversation
 * Get conversation history for a spec mode run
 */
runs.get('/:id/conversation', (c) => {
  const runId = c.req.param('id');
  logger.debug('GET /api/runs/:id/conversation called', { runId });

  // Check if this is a spec mode run
  const mode = runStore.getMode(runId);
  if (mode !== 'spec') {
    return c.json({
      error: {
        message: `Run ${runId} is not in spec mode`,
      },
    }, 400);
  }

  const conversation = getConversation(runId);
  if (!conversation) {
    return c.json({
      error: {
        message: `Conversation not found for run ${runId}`,
      },
    }, 404);
  }

  const response: ConversationResponse = {
    run_id: conversation.run_id,
    messages: conversation.messages,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
  };

  return c.json(response);
});

/**
 * GET /api/runs/:id/threads
 * Get all conversation threads for a spec mode run
 */
runs.get('/:id/threads', (c) => {
  const runId = c.req.param('id');
  logger.debug('GET /api/runs/:id/threads called', { runId });

  const mode = runStore.getMode(runId);
  if (mode !== 'spec') {
    return c.json({
      error: {
        message: `Run ${runId} is not in spec mode`,
      },
    }, 400);
  }

  const tree = getConversationTree(runId);
  const activeThread = getActiveThread(runId);

  return c.json({
    run_id: runId,
    active_thread_id: activeThread?.conversation_id,
    threads: tree.map(item => ({
      conversation_id: item.thread.conversation_id,
      name: item.thread.name,
      parent_conversation_id: item.thread.parent_conversation_id,
      branch_point_seq: item.thread.branch_point_seq,
      is_active: item.thread.is_active,
      message_count: item.messageCount,
      children: item.children,
      created_at: item.thread.created_at,
      updated_at: item.thread.updated_at,
    })),
  });
});

/**
 * POST /api/runs/:id/threads
 * Create a new conversation thread (branch from existing)
 */
runs.post('/:id/threads', async (c) => {
  const runId = c.req.param('id');
  logger.info('POST /api/runs/:id/threads received', { runId });

  const mode = runStore.getMode(runId);
  if (mode !== 'spec') {
    return c.json({
      error: {
        message: `Run ${runId} is not in spec mode`,
      },
    }, 400);
  }

  try {
    const body = await c.req.json();
    const { name, parent_conversation_id, branch_point_seq } = body as {
      name?: string;
      parent_conversation_id?: string;
      branch_point_seq?: number;
    };

    let newThread;
    if (parent_conversation_id !== undefined && branch_point_seq !== undefined) {
      // Branch from existing conversation
      newThread = branchFromMessage(parent_conversation_id, branch_point_seq, name);
      if (!newThread) {
        return c.json({
          error: {
            message: `Failed to branch from conversation ${parent_conversation_id} at seq ${branch_point_seq}`,
          },
        }, 400);
      }
    } else {
      // Create a new independent thread
      newThread = createThread(runId, { name });
    }

    return c.json({
      conversation_id: newThread.conversation_id,
      run_id: newThread.run_id,
      name: newThread.name,
      parent_conversation_id: newThread.parent_conversation_id,
      branch_point_seq: newThread.branch_point_seq,
      is_active: newThread.is_active,
      created_at: newThread.created_at,
    }, 201);
  } catch (error) {
    logger.error('Error creating thread', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to create thread',
      },
    }, 500);
  }
});

/**
 * PUT /api/runs/:id/threads/:threadId/activate
 * Switch to a different conversation thread
 */
runs.put('/:id/threads/:threadId/activate', (c) => {
  const runId = c.req.param('id');
  const threadId = c.req.param('threadId');
  logger.info('PUT /api/runs/:id/threads/:threadId/activate received', { runId, threadId });

  const mode = runStore.getMode(runId);
  if (mode !== 'spec') {
    return c.json({
      error: {
        message: `Run ${runId} is not in spec mode`,
      },
    }, 400);
  }

  const success = switchThread(runId, threadId);
  if (!success) {
    return c.json({
      error: {
        message: `Failed to switch to thread ${threadId}`,
      },
    }, 400);
  }

  return c.json({
    message: `Switched to thread ${threadId}`,
    active_thread_id: threadId,
  });
});

/**
 * GET /api/runs/:id/threads/:threadId/messages
 * Get messages for a specific conversation thread
 */
runs.get('/:id/threads/:threadId/messages', (c) => {
  const runId = c.req.param('id');
  const threadId = c.req.param('threadId');
  logger.debug('GET /api/runs/:id/threads/:threadId/messages called', { runId, threadId });

  const mode = runStore.getMode(runId);
  if (mode !== 'spec') {
    return c.json({
      error: {
        message: `Run ${runId} is not in spec mode`,
      },
    }, 400);
  }

  const messages = getThreadMessages(threadId);

  return c.json({
    conversation_id: threadId,
    messages: messages.map(msg => {
      let toolCalls: unknown;
      if (msg.tool_calls_json) {
        try {
          toolCalls = JSON.parse(msg.tool_calls_json);
        } catch {
          logger.warn('Failed to parse tool_calls_json for message', { threadId, seq: msg.seq });
        }
      }
      return {
        seq: msg.seq,
        role: msg.role,
        content: msg.content,
        tool_calls: toolCalls,
        created_at: msg.created_at,
      };
    }),
  });
});

export { runs };
