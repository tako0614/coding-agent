/**
 * Analyze Status Node
 * Reviews current state, browses files, and prepares context for task planning
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import type { ParallelSupervisorStateType } from '../parallel-state.js';
import { getOpenAIConfig, getDAGModel } from '../../services/settings-store.js';
import { log as eventLog } from '../../services/event-bus.js';
import { createFileTools } from '../../tools/file-tools.js';

const ANALYZE_PROMPT = `You are analyzing the current state of a project to prepare for the next step.

Your job is to:
1. Understand the current goal and context
2. Review what has been done (if any previous iterations)
3. Identify what files or information might be relevant
4. Prepare a clear status summary for task planning

You have access to file tools. Use them to browse the repository and understand the current state.

## Available Actions
- LIST_FILES: dir_path - List files in a directory
- READ_FILE: file_path - Read a file's contents
- FIND_FILES: pattern - Find files matching a pattern
- STATUS_SUMMARY: your_summary - Output your analysis

Output actions as JSON:
{"action": "LIST_FILES", "path": "."}
{"action": "READ_FILE", "path": "src/main.ts"}
{"action": "STATUS_SUMMARY", "summary": "..."}

Start by exploring relevant files, then output a STATUS_SUMMARY when ready.`;

interface AnalyzeAction {
  action: 'LIST_FILES' | 'READ_FILE' | 'FIND_FILES' | 'STATUS_SUMMARY';
  path?: string;
  pattern?: string;
  summary?: string;
}

/**
 * Analyze status node - reviews current state before task planning
 */
export async function analyzeStatusNode(
  state: ParallelSupervisorStateType
): Promise<Partial<ParallelSupervisorStateType>> {
  const iteration = state.iteration_count ?? 0;
  console.log(`[AnalyzeStatus] Analyzing current state (iteration ${iteration})...`);
  eventLog(state.run_id, 'info', 'supervisor', `🔍 Analyzing current state (iteration ${iteration})...`);

  const fileTools = createFileTools(state.repo_path);

  // Build context for the LLM
  const contextParts: string[] = [];
  contextParts.push(`# Goal\n${state.user_goal}`);
  contextParts.push(`\n# Repository\n${state.repo_path}`);

  if (state.repo_context) {
    contextParts.push(`\n# AGENTS.md\n${state.repo_context}`);
  }

  // Add previous iteration results
  if (iteration > 0 && state.reports && state.reports.length > 0) {
    contextParts.push(`\n# Previous Results (Iteration ${iteration})`);
    const progress = state.dag_progress;
    if (progress) {
      contextParts.push(`Completed: ${progress.completed}/${progress.total}, Failed: ${progress.failed}`);
    }

    for (const report of state.reports) {
      const status = report.status === 'done' ? '✓' : '✗';
      contextParts.push(`${status} ${report.order_id}: ${report.summary}`);
      if (report.error) {
        contextParts.push(`  Error: ${report.error.message}`);
      }
    }
  }

  // Check OpenAI config
  const config = getOpenAIConfig();
  if (!config) {
    // Fallback: just list root files
    const files = await fileTools.listFiles('');
    const fileList = files.map(f => `${f.isDirectory ? '📁' : '📄'} ${f.name}`).join('\n');

    eventLog(state.run_id, 'info', 'supervisor', `📂 Repository structure:\n${fileList}`);

    return {
      status: 'planning',
      updated_at: new Date().toISOString(),
    };
  }

  try {
    const model = new ChatOpenAI({
      model: getDAGModel(),
      temperature: 0.3,
      apiKey: config.apiKey,
      configuration: config.baseUrl ? { baseURL: config.baseUrl } : undefined,
    });

    // Interactive loop with file tools
    let analysisComplete = false;
    let statusSummary = '';
    let attempts = 0;
    const maxAttempts = 10;

    const messages = [
      new SystemMessage(ANALYZE_PROMPT),
      new HumanMessage(contextParts.join('\n')),
    ];

    while (!analysisComplete && attempts < maxAttempts) {
      attempts++;

      const response = await model.invoke(messages);
      const content = response.content as string;

      // Parse actions from response
      const actionMatch = content.match(/\{[^}]+\}/g);
      if (!actionMatch) {
        // No action, treat as summary
        statusSummary = content;
        analysisComplete = true;
        break;
      }

      for (const actionStr of actionMatch) {
        try {
          const action = JSON.parse(actionStr) as AnalyzeAction;

          if (action.action === 'STATUS_SUMMARY') {
            statusSummary = action.summary ?? content;
            analysisComplete = true;
            break;
          }

          let result = '';

          if (action.action === 'LIST_FILES' && action.path !== undefined) {
            const files = await fileTools.listFiles(action.path);
            result = files.map(f => `${f.isDirectory ? '📁' : '📄'} ${f.relativePath}`).join('\n');
            eventLog(state.run_id, 'debug', 'supervisor', `Listed ${files.length} files in ${action.path}`);
          } else if (action.action === 'READ_FILE' && action.path) {
            try {
              const content = await fileTools.readFile(action.path);
              result = content.slice(0, 4000); // Limit size
              eventLog(state.run_id, 'debug', 'supervisor', `Read file: ${action.path}`);
            } catch {
              result = `Error: File not found: ${action.path}`;
            }
          } else if (action.action === 'FIND_FILES' && action.pattern) {
            const regex = new RegExp(action.pattern, 'i');
            const files = await fileTools.findFiles(regex);
            result = files.slice(0, 50).map(f => f.relativePath).join('\n');
            eventLog(state.run_id, 'debug', 'supervisor', `Found ${files.length} files matching ${action.pattern}`);
          }

          messages.push(new AIMessage(content));
          messages.push(new HumanMessage(`Result:\n${result}`));
        } catch {
          // Invalid JSON, skip
        }
      }
    }

    if (statusSummary) {
      eventLog(state.run_id, 'info', 'supervisor', `📋 Status: ${statusSummary.slice(0, 200)}...`);
    }

    return {
      status: 'planning',
      updated_at: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[AnalyzeStatus] Error:', error);
    // Continue anyway
    return {
      status: 'planning',
      updated_at: new Date().toISOString(),
    };
  }
}
