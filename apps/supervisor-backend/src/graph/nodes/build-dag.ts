/**
 * Build DAG Node
 * Converts user goal into a DAG of tasks using LLM
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { DAG, DAGNode, DAGEdge } from '@supervisor/protocol';
import { createDAGId, createTaskId } from '@supervisor/protocol';
import type { ParallelSupervisorStateType } from '../parallel-state.js';
import { getOpenAIConfig, getDAGModel, type OpenAIConfig } from '../../services/settings-store.js';
import { log as eventLog } from '../../services/event-bus.js';

// Minimal system prompt - let the repo's own docs guide behavior
const SYSTEM_PROMPT = `You decompose goals into executable tasks.

Read the repository context carefully - it may contain AGENTS.md or similar files with specific instructions for how to work in this codebase.

Output a JSON object with tasks array:
{
  "tasks": [
    {
      "id": "task_1",
      "name": "Short task name",
      "description": "Detailed description including relevant context from the repo",
      "dependencies": ["task_id"],
      "executor_preference": "codex" | "claude" | "any",
      "priority": 1-10
    }
  ]
}

## Guidelines
- Follow any instructions in AGENTS.md, CLAUDE.md, or similar files
- Create parallel tasks when possible (empty dependencies)
- Add dependencies only when strictly required
- Include enough context in descriptions for autonomous execution

## Executor Selection - IMPORTANT
Choose executor_preference based on task characteristics:

### Use "claude" for (simple implementation tasks):
- Simple file edits (add import, rename variable, fix typo)
- Straightforward code changes with clear patterns
- Running commands and scripts
- File operations (create, copy, move, delete)
- Quick bug fixes with obvious solutions
- Code formatting and cleanup
- Simple test additions

### Use "codex" for (complex tasks requiring reasoning):
- Architectural decisions and system design
- Planning implementation strategy
- Complex feature implementation
- Multi-file refactoring with design considerations
- Writing new features that require understanding context
- Debugging complex issues requiring analysis
- Code review and quality assessment
- API design and interface planning
- Security analysis and vulnerability fixes
- Performance analysis and optimization
- Writing comprehensive tests
- Documentation and technical writing
- Complex problem solving
- Any task requiring deep thinking or multi-step reasoning

### Use "any" for:
- Tasks that either executor can handle equally well
- When unsure which is better

Prefer "claude" for simple, mechanical tasks.
Prefer "codex" for complex tasks requiring thinking, reasoning, or design.`;

interface ParsedTask {
  id: string;
  name: string;
  description: string;
  dependencies: string[];
  executor_preference: 'codex' | 'claude' | 'any';
  priority: number;
  estimated_duration_ms?: number;
}

/**
 * Check if OpenAI API is available (supports direct OpenAI or Copilot API proxy)
 */
function checkOpenAIConfig(): { config: OpenAIConfig } | { error: string } {
  const config = getOpenAIConfig();
  if (!config) {
    return {
      error: 'OpenAI API is not configured. Please either:\n' +
        '1. Set OpenAI API key in Settings, or\n' +
        '2. Enable Copilot API and run copilot-api proxy (npx copilot-api@latest start)',
    };
  }
  return { config };
}

/**
 * Build DAG node - converts user goal into a task DAG
 */
export async function buildDAGNode(
  state: ParallelSupervisorStateType
): Promise<Partial<ParallelSupervisorStateType>> {
  console.log('[BuildDAG] Building task DAG from goal...');
  eventLog(state.run_id, 'info', 'supervisor', '🧠 Building task DAG from goal...', { node: 'build_dag' });

  // Check for API configuration before attempting to use the model
  const configCheck = checkOpenAIConfig();
  if ('error' in configCheck) {
    console.error(`[BuildDAG] ${configCheck.error}`);
    // Create a fallback single-task DAG instead of failing
    const fallbackDag = createFallbackDAG(state);
    console.log('[BuildDAG] Created fallback DAG with single task (API not configured)');
    return {
      dag: fallbackDag,
      status: 'building_dag',
      error: configCheck.error,
      updated_at: new Date().toISOString(),
    };
  }

  const { config } = configCheck;
  const modelName = getDAGModel();

  console.log(`[BuildDAG] Using model: ${modelName} via ${config.useCopilot ? 'Copilot API' : 'OpenAI API'}${config.baseUrl ? ` at ${config.baseUrl}` : ''}`);
  eventLog(state.run_id, 'info', 'supervisor', `🤖 Using model: ${modelName}`, { node: 'build_dag', model: modelName });

  try {
    const model = new ChatOpenAI({
      model: modelName,
      temperature: 0.2,
      apiKey: config.apiKey,
      configuration: config.baseUrl ? {
        baseURL: config.baseUrl,
      } : undefined,
    });

    const userPrompt = buildUserPrompt(state);

    // Build messages array: use existing conversation history or start fresh
    const messagesToSend: BaseMessage[] = [];

    // Add system prompt first
    messagesToSend.push(new SystemMessage(SYSTEM_PROMPT));

    // Add conversation history if available (for multi-turn context)
    if (state.messages && state.messages.length > 0) {
      console.log(`[BuildDAG] Using ${state.messages.length} messages from conversation history`);
      messagesToSend.push(...state.messages);
    }

    // Add the current request as user message
    messagesToSend.push(new HumanMessage(userPrompt));

    const response = await model.invoke(messagesToSend);

    const content = response.content as string;

    // Parse the JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse DAG from LLM response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as { tasks: ParsedTask[] };

    // Build the DAG
    const dag = buildDAGFromTasks(parsed.tasks, state.run_id);

    console.log(`[BuildDAG] Created DAG with ${dag.nodes.length} tasks`);

    // Log each task with its executor preference
    eventLog(state.run_id, 'info', 'supervisor', `📋 Created ${dag.nodes.length} tasks:`, { node: 'build_dag' });
    for (const node of dag.nodes) {
      const execLabel = node.executor_preference === 'codex' ? '🟢' : node.executor_preference === 'claude' ? '🟣' : '⚪';
      eventLog(state.run_id, 'info', 'supervisor', `  ${execLabel} ${node.name}`, {
        task_id: node.task_id,
        executor_preference: node.executor_preference,
        priority: node.priority,
      });
    }

    // Append the AI response to conversation history
    const updatedMessages = [
      ...(state.messages ?? []),
      new HumanMessage(userPrompt),
      new AIMessage(content),
    ];

    return {
      dag,
      messages: updatedMessages,
      status: 'building_dag',
      updated_at: new Date().toISOString(),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[BuildDAG] Error building DAG: ${errorMessage}`);

    // Create a fallback single-task DAG
    const fallbackDag = createFallbackDAG(state);
    console.log('[BuildDAG] Created fallback DAG with single task due to error');

    return {
      dag: fallbackDag,
      status: 'building_dag',
      error: `DAG generation failed: ${errorMessage}`,
      updated_at: new Date().toISOString(),
    };
  }
}

/**
 * Create a fallback DAG with a single task when LLM is unavailable
 */
function createFallbackDAG(state: ParallelSupervisorStateType): DAG {
  const now = new Date().toISOString();
  const dagId = createDAGId();
  const taskId = createTaskId();

  return {
    dag_id: dagId,
    run_id: state.run_id,
    nodes: [{
      task_id: taskId,
      name: 'Execute Goal',
      description: state.user_goal,
      dependencies: [],
      executor_preference: 'claude',
      priority: 10,
      status: 'pending',
    }],
    edges: [],
    created_at: now,
    updated_at: now,
  };
}

function buildUserPrompt(state: ParallelSupervisorStateType): string {
  const lines: string[] = [];

  lines.push(`# Goal\n${state.user_goal}`);
  lines.push('');
  lines.push(`# Repository\n${state.repo_path}`);
  lines.push('');

  // Include repo context (AGENTS.md, README.md, etc.)
  if (state.repo_context) {
    lines.push('# Repository Context');
    lines.push('');
    // Limit context to avoid token overflow
    const maxContextLength = 8000;
    const context = state.repo_context.length > maxContextLength
      ? state.repo_context.slice(0, maxContextLength) + '\n\n... (truncated)'
      : state.repo_context;
    lines.push(context);
  } else {
    lines.push('# Repository Context\nNo AGENTS.md, README.md, or spec files found.');
  }

  return lines.join('\n');
}

function buildDAGFromTasks(tasks: ParsedTask[], runId: string): DAG {
  const now = new Date().toISOString();
  const dagId = createDAGId();

  // Create task ID mapping (user ID -> real ID)
  const idMap = new Map<string, string>();
  for (const task of tasks) {
    idMap.set(task.id, createTaskId());
  }

  // Build nodes
  const nodes: DAGNode[] = tasks.map((task) => ({
    task_id: idMap.get(task.id)!,
    name: task.name,
    description: task.description,
    dependencies: task.dependencies.map((dep) => idMap.get(dep) ?? dep),
    executor_preference: task.executor_preference,
    priority: task.priority,
    estimated_duration_ms: task.estimated_duration_ms,
    status: 'pending',
  }));

  // Build edges from dependencies
  const edges: DAGEdge[] = [];
  for (const node of nodes) {
    for (const dep of node.dependencies) {
      edges.push({
        from: dep,
        to: node.task_id,
      });
    }
  }

  return {
    dag_id: dagId,
    run_id: runId,
    nodes,
    edges,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Create a simple DAG from a list of sequential tasks (for simple cases)
 */
export function createSequentialDAG(
  tasks: Array<{ name: string; description: string }>,
  runId: string
): DAG {
  const now = new Date().toISOString();
  const dagId = createDAGId();

  const nodes: DAGNode[] = [];
  const edges: DAGEdge[] = [];
  let prevTaskId: string | undefined;

  for (let i = 0; i < tasks.length; i++) {
    const taskId = createTaskId();
    const task = tasks[i]!;

    nodes.push({
      task_id: taskId,
      name: task.name,
      description: task.description,
      dependencies: prevTaskId ? [prevTaskId] : [],
      executor_preference: 'any',
      priority: tasks.length - i, // Higher priority for earlier tasks
      status: 'pending',
    });

    if (prevTaskId) {
      edges.push({
        from: prevTaskId,
        to: taskId,
      });
    }

    prevTaskId = taskId;
  }

  return {
    dag_id: dagId,
    run_id: runId,
    nodes,
    edges,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Create a parallel DAG where all tasks can run simultaneously
 */
export function createParallelDAG(
  tasks: Array<{ name: string; description: string; priority?: number }>,
  runId: string
): DAG {
  const now = new Date().toISOString();
  const dagId = createDAGId();

  const nodes: DAGNode[] = tasks.map((task, i) => ({
    task_id: createTaskId(),
    name: task.name,
    description: task.description,
    dependencies: [],
    executor_preference: 'any' as const,
    priority: task.priority ?? 5,
    status: 'pending' as const,
  }));

  return {
    dag_id: dagId,
    run_id: runId,
    nodes,
    edges: [],
    created_at: now,
    updated_at: now,
  };
}
