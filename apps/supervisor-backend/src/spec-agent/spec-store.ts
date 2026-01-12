/**
 * Spec Agent conversation store
 * Persists conversation history to SQLite
 * Uses run locks to prevent concurrent modifications
 */

import { db } from '../services/db.js';
import { logger } from '../services/logger.js';
import { withRunLock } from '../services/run-lock.js';

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  tool_calls?: Array<{
    tool: string;
    input: Record<string, unknown>;
    output?: string;
  }>;
}

export interface Conversation {
  run_id: string;
  messages: ConversationMessage[];
  created_at: string;
  updated_at: string;
}

// Prepared statements for normalized messages table
const getMessagesStmt = db.prepare(`
  SELECT id, run_id, seq, role, content, tool_calls_json, created_at
  FROM conversation_messages
  WHERE run_id = ?
  ORDER BY seq ASC
`);

const insertMessageStmt = db.prepare(`
  INSERT INTO conversation_messages (run_id, seq, role, content, tool_calls_json, created_at)
  VALUES (@run_id, @seq, @role, @content, @tool_calls_json, @created_at)
`);

const getNextSeqStmt = db.prepare(`
  SELECT COALESCE(MAX(seq), -1) + 1 as next_seq
  FROM conversation_messages
  WHERE run_id = ?
`);

const deleteMessagesStmt = db.prepare(`
  DELETE FROM conversation_messages WHERE run_id = ?
`);

const getConversationMetaStmt = db.prepare(`
  SELECT
    MIN(created_at) as created_at,
    MAX(created_at) as updated_at
  FROM conversation_messages
  WHERE run_id = ?
`);

// Legacy statements for backward compatibility
const getConversationStmt = db.prepare(`
  SELECT * FROM conversations WHERE run_id = ?
`);

const upsertConversationStmt = db.prepare(`
  INSERT INTO conversations (run_id, messages_json, created_at, updated_at)
  VALUES (@run_id, @messages_json, @created_at, @updated_at)
  ON CONFLICT(run_id) DO UPDATE SET
    messages_json = excluded.messages_json,
    updated_at = excluded.updated_at
`);

const deleteConversationStmt = db.prepare(`
  DELETE FROM conversations WHERE run_id = ?
`);

interface MessageRow {
  id: number;
  run_id: string;
  seq: number;
  role: string;
  content: string;
  tool_calls_json: string | null;
  created_at: string;
}

interface ConversationRow {
  id: number;
  run_id: string;
  messages_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * Get conversation by run ID (uses normalized table)
 */
export function getConversation(runId: string): Conversation | undefined {
  try {
    // Try normalized table first
    const rows = getMessagesStmt.all(runId) as MessageRow[];

    if (rows.length > 0) {
      const messages: ConversationMessage[] = rows.map(row => {
        let toolCalls: ConversationMessage['tool_calls'];
        if (row.tool_calls_json) {
          try {
            toolCalls = JSON.parse(row.tool_calls_json);
          } catch {
            logger.warn('Failed to parse tool_calls_json', { runId, seq: row.seq });
          }
        }
        return {
          role: row.role as 'user' | 'assistant' | 'system',
          content: row.content,
          timestamp: row.created_at,
          tool_calls: toolCalls,
        };
      });

      const meta = getConversationMetaStmt.get(runId) as {
        created_at: string;
        updated_at: string;
      } | undefined;

      const firstRow = rows[0]!;
      const lastRow = rows[rows.length - 1]!;

      return {
        run_id: runId,
        messages,
        created_at: meta?.created_at || firstRow.created_at,
        updated_at: meta?.updated_at || lastRow.created_at,
      };
    }

    // Fallback to legacy JSON blob table
    const row = getConversationStmt.get(runId) as ConversationRow | undefined;
    if (!row) return undefined;

    let messages: ConversationMessage[] = [];
    try {
      const parsed = JSON.parse(row.messages_json);
      messages = Array.isArray(parsed) ? parsed : [];
    } catch (parseError) {
      logger.error('Failed to parse messages_json', {
        runId,
        error: parseError instanceof Error ? parseError.message : String(parseError),
      });
    }

    return {
      run_id: row.run_id,
      messages,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  } catch (error) {
    logger.error('Failed to get conversation', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Save conversation
 */
export function saveConversation(conversation: Conversation): void {
  try {
    const now = new Date().toISOString();
    upsertConversationStmt.run({
      run_id: conversation.run_id,
      messages_json: JSON.stringify(conversation.messages),
      created_at: conversation.created_at || now,
      updated_at: now,
    });
  } catch (error) {
    logger.error('Failed to save conversation', {
      runId: conversation.run_id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Add a message to conversation (internal, no lock)
 * Uses normalized table for efficient append-only inserts
 */
function addMessageInternal(runId: string, message: ConversationMessage): Conversation {
  const now = message.timestamp || new Date().toISOString();

  try {
    // Get next sequence number
    const seqResult = getNextSeqStmt.get(runId) as { next_seq: number };
    const nextSeq = seqResult.next_seq;

    // Insert into normalized table (single row insert, no JSON rewrite)
    insertMessageStmt.run({
      run_id: runId,
      seq: nextSeq,
      role: message.role,
      content: message.content,
      tool_calls_json: message.tool_calls ? JSON.stringify(message.tool_calls) : null,
      created_at: now,
    });

    logger.debug('Message added to conversation', {
      runId,
      seq: nextSeq,
      role: message.role,
    });
  } catch (error) {
    logger.error('Failed to add message (normalized)', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });

    // Fallback to legacy method
    const existing = getConversation(runId);
    const conversation: Conversation = existing
      ? {
          ...existing,
          messages: [...existing.messages, message],
          updated_at: now,
        }
      : {
          run_id: runId,
          messages: [message],
          created_at: now,
          updated_at: now,
        };
    saveConversation(conversation);
    return conversation;
  }

  // Return updated conversation
  return getConversation(runId) || {
    run_id: runId,
    messages: [message],
    created_at: now,
    updated_at: now,
  };
}

/**
 * Add a message to conversation with lock protection
 * Use this for external callers to prevent race conditions
 */
export async function addMessageLocked(runId: string, message: ConversationMessage): Promise<Conversation> {
  return withRunLock(runId, 'addMessage', async () => {
    return addMessageInternal(runId, message);
  });
}

/**
 * Add a message to conversation (synchronous, no lock)
 * @deprecated Use addMessageLocked for concurrent safety
 */
export function addMessage(runId: string, message: ConversationMessage): Conversation {
  return addMessageInternal(runId, message);
}

/**
 * Delete conversation (from both normalized and legacy tables)
 */
export function deleteConversation(runId: string): boolean {
  try {
    // Delete from normalized table
    const normalizedResult = deleteMessagesStmt.run(runId);
    // Delete from legacy table
    const legacyResult = deleteConversationStmt.run(runId);
    return normalizedResult.changes > 0 || legacyResult.changes > 0;
  } catch (error) {
    logger.error('Failed to delete conversation', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Convert messages to Anthropic API format
 */
export function toAnthropicMessages(messages: ConversationMessage[]): Array<{
  role: 'user' | 'assistant';
  content: string;
}> {
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
}
