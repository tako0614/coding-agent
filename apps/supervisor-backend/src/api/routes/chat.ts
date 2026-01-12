/**
 * OpenAI-compatible /v1/chat/completions endpoint
 */

import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { createRunId } from '@supervisor/protocol';
import { ChatCompletionRequestSchema, type ChatCompletionResponse } from '../types.js';
import { runStore } from '../run-store.js';
import { runSimplifiedSupervisor } from '../../graph/index.js';

const chat = new Hono();

/**
 * POST /v1/chat/completions
 * OpenAI-compatible chat completions endpoint
 */
chat.post('/completions', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = ChatCompletionRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({
        error: {
          message: 'Invalid request body',
          type: 'invalid_request_error',
          details: parsed.error.errors,
        },
      }, 400);
    }

    const request = parsed.data;

    // Extract the user's goal from the last user message
    const userMessages = request.messages.filter(m => m.role === 'user');
    const lastUserMessage = userMessages[userMessages.length - 1];

    if (!lastUserMessage) {
      return c.json({
        error: {
          message: 'No user message found',
          type: 'invalid_request_error',
        },
      }, 400);
    }

    const userGoal = lastUserMessage.content;

    // Get repo path from request or use current directory
    const repoPath = request.repo_path ?? process.cwd();

    // Generate run ID
    const runId = request.run_id ?? createRunId();

    console.log(`[API] Starting supervisor run ${runId}`);

    // Handle streaming (not fully implemented for MVP)
    if (request.stream) {
      // For MVP, we'll just return a simple streaming response
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');

      // Start the run in background
      const runPromise = runSimplifiedSupervisor({
        userGoal,
        repoPath,
        runId,
      });
      runStore.setRunning(runId, runPromise, userGoal, undefined, repoPath);

      // Send initial chunk
      const initialChunk = {
        id: `chatcmpl-${uuidv4()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: `Starting supervisor run ${runId}...\n` },
          finish_reason: null,
        }],
      };

      // Wait for completion and stream result
      const finalState = await runPromise;
      runStore.set(runId, finalState);

      const finalChunk = {
        id: `chatcmpl-${uuidv4()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          delta: { content: finalState.final_summary ?? `Run completed with status: ${finalState.status}` },
          finish_reason: 'stop',
        }],
      };

      return c.text(
        `data: ${JSON.stringify(initialChunk)}\n\n` +
        `data: ${JSON.stringify(finalChunk)}\n\n` +
        `data: [DONE]\n\n`
      );
    }

    // Non-streaming: run synchronously
    const runPromise = runSimplifiedSupervisor({
      userGoal,
      repoPath,
      runId,
    });
    runStore.setRunning(runId, runPromise, userGoal);

    const finalState = await runPromise;
    runStore.set(runId, finalState);

    // Build response
    const response: ChatCompletionResponse = {
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: finalState.final_summary ?? `Run completed with status: ${finalState.status}`,
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 0, // Would need actual token counting
        completion_tokens: 0,
        total_tokens: 0,
      },
      supervisor: {
        run_id: runId,
        status: finalState.status,
        verification_passed: finalState.status === 'completed',
        files_modified: [],
      },
    };

    return c.json(response);
  } catch (error) {
    console.error('[API] Error in chat completions:', error);
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Internal server error',
        type: 'internal_error',
      },
    }, 500);
  }
});

export { chat };
