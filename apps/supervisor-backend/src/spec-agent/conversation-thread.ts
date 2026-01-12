/**
 * Conversation Thread Service
 *
 * Manages conversation threads for branching and re-execution.
 * Allows users to:
 * - Create new conversation threads
 * - Branch from a specific message
 * - Switch between threads
 * - View conversation history tree
 */

import { db } from '../services/db.js';
import { logger } from '../services/logger.js';
import { v4 as uuidv4 } from 'uuid';

export interface ConversationThread {
  conversation_id: string;
  run_id: string;
  parent_conversation_id?: string;
  branch_point_seq?: number;
  name?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ThreadMessage {
  id: number;
  conversation_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tool_calls_json?: string;
  created_at: string;
}

// Generate a conversation ID
function createConversationId(): string {
  return `conv_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
}

// Prepared statements
const insertThreadStmt = db.prepare(`
  INSERT INTO conversation_threads
    (conversation_id, run_id, parent_conversation_id, branch_point_seq, name, is_active, created_at, updated_at)
  VALUES
    (@conversation_id, @run_id, @parent_conversation_id, @branch_point_seq, @name, @is_active, @created_at, @updated_at)
`);

const getThreadStmt = db.prepare(`
  SELECT * FROM conversation_threads WHERE conversation_id = ?
`);

const getThreadsByRunStmt = db.prepare(`
  SELECT * FROM conversation_threads WHERE run_id = ? ORDER BY created_at ASC
`);

const getActiveThreadStmt = db.prepare(`
  SELECT * FROM conversation_threads WHERE run_id = ? AND is_active = 1 LIMIT 1
`);

const updateThreadStmt = db.prepare(`
  UPDATE conversation_threads SET
    name = COALESCE(@name, name),
    is_active = @is_active,
    updated_at = @updated_at
  WHERE conversation_id = @conversation_id
`);

const deactivateAllThreadsStmt = db.prepare(`
  UPDATE conversation_threads SET is_active = 0, updated_at = ? WHERE run_id = ?
`);

const deleteThreadStmt = db.prepare(`
  DELETE FROM conversation_threads WHERE conversation_id = ?
`);

const getThreadMessagesStmt = db.prepare(`
  SELECT * FROM conversation_messages
  WHERE conversation_id = ?
  ORDER BY seq ASC
`);

const insertMessageWithThreadStmt = db.prepare(`
  INSERT INTO conversation_messages
    (run_id, conversation_id, seq, role, content, tool_calls_json, created_at)
  VALUES
    (@run_id, @conversation_id, @seq, @role, @content, @tool_calls_json, @created_at)
`);

const getNextSeqForThreadStmt = db.prepare(`
  SELECT COALESCE(MAX(seq), -1) + 1 as next_seq
  FROM conversation_messages
  WHERE conversation_id = ?
`);

const copyMessagesUpToSeqStmt = db.prepare(`
  INSERT INTO conversation_messages (run_id, conversation_id, seq, role, content, tool_calls_json, created_at)
  SELECT run_id, ?, seq, role, content, tool_calls_json, created_at
  FROM conversation_messages
  WHERE conversation_id = ? AND seq <= ?
  ORDER BY seq ASC
`);

interface ThreadRow {
  conversation_id: string;
  run_id: string;
  parent_conversation_id: string | null;
  branch_point_seq: number | null;
  name: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function rowToThread(row: ThreadRow): ConversationThread {
  return {
    conversation_id: row.conversation_id,
    run_id: row.run_id,
    parent_conversation_id: row.parent_conversation_id || undefined,
    branch_point_seq: row.branch_point_seq ?? undefined,
    name: row.name || undefined,
    is_active: row.is_active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Transaction wrapper for multi-step operations
const createThreadTransaction = db.transaction((
  conversationId: string,
  runId: string,
  options: {
    name?: string;
    parentConversationId?: string;
    branchPointSeq?: number;
  },
  now: string
) => {
  // If branching, copy messages up to branch point
  if (options.parentConversationId && options.branchPointSeq !== undefined) {
    copyMessagesUpToSeqStmt.run(
      conversationId,
      options.parentConversationId,
      options.branchPointSeq
    );
  }

  // Deactivate other threads if this is a new active thread
  deactivateAllThreadsStmt.run(now, runId);

  // Insert the new thread
  insertThreadStmt.run({
    conversation_id: conversationId,
    run_id: runId,
    parent_conversation_id: options.parentConversationId || null,
    branch_point_seq: options.branchPointSeq ?? null,
    name: options.name || null,
    is_active: 1,
    created_at: now,
    updated_at: now,
  });
});

/**
 * Create a new conversation thread for a run
 * Uses a transaction to ensure atomicity
 */
export function createThread(
  runId: string,
  options: {
    name?: string;
    parentConversationId?: string;
    branchPointSeq?: number;
  } = {}
): ConversationThread {
  const now = new Date().toISOString();
  const conversationId = createConversationId();

  try {
    // Execute all operations in a single transaction
    createThreadTransaction(conversationId, runId, options, now);

    logger.debug('Created conversation thread', {
      conversationId,
      runId,
      parentConversationId: options.parentConversationId,
    });

    return {
      conversation_id: conversationId,
      run_id: runId,
      parent_conversation_id: options.parentConversationId,
      branch_point_seq: options.branchPointSeq,
      name: options.name,
      is_active: true,
      created_at: now,
      updated_at: now,
    };
  } catch (err) {
    logger.error('Failed to create conversation thread', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Get a conversation thread by ID
 */
export function getThread(conversationId: string): ConversationThread | undefined {
  try {
    const row = getThreadStmt.get(conversationId) as ThreadRow | undefined;
    if (!row) return undefined;
    return rowToThread(row);
  } catch (err) {
    logger.error('Failed to get conversation thread', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Get all conversation threads for a run
 */
export function getThreadsForRun(runId: string): ConversationThread[] {
  try {
    const rows = getThreadsByRunStmt.all(runId) as ThreadRow[];
    return rows.map(rowToThread);
  } catch (err) {
    logger.error('Failed to get threads for run', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Get the active conversation thread for a run
 */
export function getActiveThread(runId: string): ConversationThread | undefined {
  try {
    const row = getActiveThreadStmt.get(runId) as ThreadRow | undefined;
    if (!row) return undefined;
    return rowToThread(row);
  } catch (err) {
    logger.error('Failed to get active thread', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Get or create the active thread for a run
 * If no thread exists, creates a default one
 */
export function getOrCreateActiveThread(runId: string): ConversationThread {
  const existing = getActiveThread(runId);
  if (existing) return existing;

  return createThread(runId, { name: 'Main' });
}

// Transaction wrapper for thread switching
const switchThreadTransaction = db.transaction((
  runId: string,
  conversationId: string,
  now: string
) => {
  // Deactivate all threads
  deactivateAllThreadsStmt.run(now, runId);

  // Activate the target thread
  updateThreadStmt.run({
    conversation_id: conversationId,
    name: null, // Keep existing name
    is_active: 1,
    updated_at: now,
  });
});

/**
 * Switch to a different conversation thread
 * Uses a transaction to ensure atomicity
 */
export function switchThread(runId: string, conversationId: string): boolean {
  try {
    const now = new Date().toISOString();

    // Execute in transaction
    switchThreadTransaction(runId, conversationId, now);

    logger.debug('Switched conversation thread', { runId, conversationId });
    return true;
  } catch (err) {
    logger.error('Failed to switch thread', {
      runId,
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Branch from a specific message in a conversation
 */
export function branchFromMessage(
  conversationId: string,
  messageSeq: number,
  name?: string
): ConversationThread | undefined {
  try {
    const parentThread = getThread(conversationId);
    if (!parentThread) {
      logger.error('Parent thread not found for branching', { conversationId });
      return undefined;
    }

    return createThread(parentThread.run_id, {
      name: name || `Branch from ${messageSeq}`,
      parentConversationId: conversationId,
      branchPointSeq: messageSeq,
    });
  } catch (err) {
    logger.error('Failed to branch conversation', {
      conversationId,
      messageSeq,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Add a message to a conversation thread
 */
export function addMessageToThread(
  conversationId: string,
  message: {
    role: 'user' | 'assistant' | 'system';
    content: string;
    tool_calls?: unknown;
  }
): number {
  try {
    const thread = getThread(conversationId);
    if (!thread) {
      throw new Error(`Thread not found: ${conversationId}`);
    }

    const seqResult = getNextSeqForThreadStmt.get(conversationId) as { next_seq: number };
    const nextSeq = seqResult.next_seq;
    const now = new Date().toISOString();

    insertMessageWithThreadStmt.run({
      run_id: thread.run_id,
      conversation_id: conversationId,
      seq: nextSeq,
      role: message.role,
      content: message.content,
      tool_calls_json: message.tool_calls ? JSON.stringify(message.tool_calls) : null,
      created_at: now,
    });

    return nextSeq;
  } catch (err) {
    logger.error('Failed to add message to thread', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Get messages for a conversation thread
 */
export function getThreadMessages(conversationId: string): ThreadMessage[] {
  try {
    const rows = getThreadMessagesStmt.all(conversationId) as Array<{
      id: number;
      conversation_id: string;
      seq: number;
      role: string;
      content: string;
      tool_calls_json: string | null;
      created_at: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      conversation_id: row.conversation_id,
      seq: row.seq,
      role: row.role as 'user' | 'assistant' | 'system',
      content: row.content,
      tool_calls_json: row.tool_calls_json || undefined,
      created_at: row.created_at,
    }));
  } catch (err) {
    logger.error('Failed to get thread messages', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Delete a conversation thread and its messages
 */
export function deleteThread(conversationId: string): boolean {
  try {
    // Messages are deleted via CASCADE
    const result = deleteThreadStmt.run(conversationId);
    return result.changes > 0;
  } catch (err) {
    logger.error('Failed to delete thread', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Get the conversation tree structure for a run
 */
export function getConversationTree(runId: string): Array<{
  thread: ConversationThread;
  messageCount: number;
  children: string[];
}> {
  const threads = getThreadsForRun(runId);

  return threads.map(thread => {
    const messages = getThreadMessages(thread.conversation_id);
    const children = threads
      .filter(t => t.parent_conversation_id === thread.conversation_id)
      .map(t => t.conversation_id);

    return {
      thread,
      messageCount: messages.length,
      children,
    };
  });
}
