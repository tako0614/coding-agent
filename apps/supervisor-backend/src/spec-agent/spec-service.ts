/**
 * Specification Service
 *
 * Manages structured specifications and their links to implementation runs.
 */

import { db } from '../services/db.js';
import { logger } from '../services/logger.js';
import {
  type StructuredSpec,
  validateSpec,
  specToMarkdown,
} from './spec-schema.js';

// Lazy-initialized prepared statements (for hot-reload compatibility)
function getInsertSpecStmt() {
  return db.prepare(`
    INSERT INTO structured_specs (spec_run_id, spec_json, markdown, created_at, updated_at)
    VALUES (@spec_run_id, @spec_json, @markdown, @created_at, @updated_at)
  `);
}

function getUpdateSpecStmt() {
  return db.prepare(`
    UPDATE structured_specs SET
      spec_json = @spec_json,
      markdown = @markdown,
      updated_at = @updated_at
    WHERE spec_run_id = @spec_run_id
  `);
}

function getGetSpecStmt() {
  return db.prepare(`
    SELECT * FROM structured_specs WHERE spec_run_id = ?
  `);
}

function getDeleteSpecStmt() {
  return db.prepare(`
    DELETE FROM structured_specs WHERE spec_run_id = ?
  `);
}

function getInsertLinkStmt() {
  return db.prepare(`
    INSERT INTO run_spec_links (impl_run_id, spec_run_id, created_at)
    VALUES (?, ?, ?)
  `);
}

function getLinkedSpecStmt() {
  return db.prepare(`
    SELECT s.* FROM structured_specs s
    INNER JOIN run_spec_links l ON s.spec_run_id = l.spec_run_id
    WHERE l.impl_run_id = ?
  `);
}

function getImplementationsForSpecStmt() {
  return db.prepare(`
    SELECT impl_run_id FROM run_spec_links WHERE spec_run_id = ?
  `);
}

interface SpecRow {
  id: number;
  spec_run_id: string;
  spec_json: string;
  markdown: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Save a structured specification
 */
export function saveStructuredSpec(
  specRunId: string,
  spec: StructuredSpec
): { success: boolean; errors?: string[] } {
  // Validate first
  const validation = validateSpec(spec);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  const now = new Date().toISOString();
  const specJson = JSON.stringify(spec);
  const markdown = specToMarkdown(spec);

  try {
    // Check if exists
    const existing = getGetSpecStmt().get(specRunId) as SpecRow | undefined;

    if (existing) {
      getUpdateSpecStmt().run({
        spec_run_id: specRunId,
        spec_json: specJson,
        markdown,
        updated_at: now,
      });
    } else {
      getInsertSpecStmt().run({
        spec_run_id: specRunId,
        spec_json: specJson,
        markdown,
        created_at: now,
        updated_at: now,
      });
    }

    logger.debug('Structured spec saved', { specRunId });
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Failed to save structured spec', { specRunId, error });
    return { success: false, errors: [error] };
  }
}

/**
 * Get structured specification by run ID
 */
export function getStructuredSpec(specRunId: string): StructuredSpec | undefined {
  try {
    const row = getGetSpecStmt().get(specRunId) as SpecRow | undefined;
    if (!row) return undefined;

    return JSON.parse(row.spec_json) as StructuredSpec;
  } catch (err) {
    logger.error('Failed to get structured spec', {
      specRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Get spec markdown by run ID
 */
export function getSpecMarkdown(specRunId: string): string | undefined {
  try {
    const row = getGetSpecStmt().get(specRunId) as SpecRow | undefined;
    if (!row) return undefined;

    return row.markdown || undefined;
  } catch (err) {
    logger.error('Failed to get spec markdown', {
      specRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Delete a structured specification
 */
export function deleteStructuredSpec(specRunId: string): boolean {
  try {
    const result = getDeleteSpecStmt().run(specRunId);
    return result.changes > 0;
  } catch (err) {
    logger.error('Failed to delete structured spec', {
      specRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Link an implementation run to a spec run
 */
export function linkImplementationToSpec(
  implRunId: string,
  specRunId: string
): boolean {
  try {
    const now = new Date().toISOString();
    getInsertLinkStmt().run(implRunId, specRunId, now);
    logger.debug('Linked implementation to spec', { implRunId, specRunId });
    return true;
  } catch (err) {
    logger.error('Failed to link implementation to spec', {
      implRunId,
      specRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Get the spec linked to an implementation run
 */
export function getSpecForImplementation(implRunId: string): StructuredSpec | undefined {
  try {
    const row = getLinkedSpecStmt().get(implRunId) as SpecRow | undefined;
    if (!row) return undefined;

    return JSON.parse(row.spec_json) as StructuredSpec;
  } catch (err) {
    logger.error('Failed to get spec for implementation', {
      implRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Get implementation run IDs that use a spec
 */
export function getImplementationsForSpec(specRunId: string): string[] {
  try {
    const rows = getImplementationsForSpecStmt().all(specRunId) as Array<{ impl_run_id: string }>;
    return rows.map(r => r.impl_run_id);
  } catch (err) {
    logger.error('Failed to get implementations for spec', {
      specRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Convert spec to context string for implementation mode
 */
export function specToImplementationContext(spec: StructuredSpec): string {
  const lines: string[] = [];

  lines.push('## Specification Context');
  lines.push('');
  lines.push(`**Title**: ${spec.metadata.title}`);
  lines.push('');
  lines.push(`**Problem**: ${spec.overview.problem_statement}`);
  lines.push('');
  lines.push(`**Solution**: ${spec.overview.proposed_solution}`);
  lines.push('');

  if (spec.requirements.length > 0) {
    lines.push('### Requirements');
    for (const req of spec.requirements) {
      const marker = req.priority === 'must' ? '🔴' : req.priority === 'should' ? '🟡' : '⚪';
      lines.push(`${marker} **${req.id}**: ${req.description}`);
    }
    lines.push('');
  }

  if (spec.design?.components && spec.design.components.length > 0) {
    lines.push('### Components to Implement');
    for (const comp of spec.design.components) {
      lines.push(`- **${comp.name}**: ${comp.description}`);
      if (comp.files && comp.files.length > 0) {
        lines.push(`  Files: ${comp.files.join(', ')}`);
      }
    }
    lines.push('');
  }

  if (spec.implementation_notes && spec.implementation_notes.length > 0) {
    lines.push('### Implementation Notes');
    for (const note of spec.implementation_notes) {
      lines.push(`- ${note}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
