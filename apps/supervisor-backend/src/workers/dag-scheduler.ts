/**
 * DAGScheduler - Manages task dependencies and scheduling
 * Determines which tasks are ready to run based on DAG structure
 */

import type {
  DAG,
  DAGNode,
  DAGNodeStatus,
  DAGProgress,
} from '@supervisor/protocol';

export class DAGScheduler {
  private dag: DAG;
  private taskStatus: Map<string, DAGNodeStatus>;
  private dependencyMap: Map<string, Set<string>>;  // task_id -> set of tasks it depends on
  private dependentMap: Map<string, Set<string>>;   // task_id -> set of tasks that depend on it

  constructor(dag: DAG) {
    this.dag = dag;
    this.taskStatus = new Map();
    this.dependencyMap = new Map();
    this.dependentMap = new Map();

    // Initialize status and dependency maps
    for (const node of dag.nodes) {
      this.taskStatus.set(node.task_id, node.status);
      this.dependencyMap.set(node.task_id, new Set(node.dependencies));
      this.dependentMap.set(node.task_id, new Set());
    }

    // Build dependent map (reverse of dependency map)
    for (const edge of dag.edges) {
      const dependents = this.dependentMap.get(edge.from);
      if (dependents) {
        dependents.add(edge.to);
      }
    }

    // Mark initial ready tasks
    this.updateReadyTasks();
  }

  /**
   * Get all tasks that are ready to run
   * (all dependencies completed, status is 'ready')
   */
  getReadyTasks(): DAGNode[] {
    const readyTasks: DAGNode[] = [];

    for (const node of this.dag.nodes) {
      if (this.taskStatus.get(node.task_id) === 'ready') {
        readyTasks.push(node);
      }
    }

    // Sort by priority (higher priority first)
    return readyTasks.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Mark a task as running
   */
  markRunning(taskId: string): void {
    this.taskStatus.set(taskId, 'running');
    this.updateNode(taskId, {
      status: 'running',
      started_at: new Date().toISOString(),
    });
  }

  /**
   * Mark a task as completed
   */
  markCompleted(taskId: string): void {
    this.taskStatus.set(taskId, 'completed');
    this.updateNode(taskId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });

    // Update ready status for dependent tasks
    this.updateReadyTasks();
  }

  /**
   * Mark a task as failed
   */
  markFailed(taskId: string, error?: string): void {
    this.taskStatus.set(taskId, 'failed');
    this.updateNode(taskId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error,
    });

    // Cancel all dependent tasks
    this.cancelDependentTasks(taskId);
  }

  /**
   * Mark a task as cancelled
   */
  markCancelled(taskId: string): void {
    this.taskStatus.set(taskId, 'cancelled');
    this.updateNode(taskId, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
    });
  }

  /**
   * Update node properties
   */
  private updateNode(taskId: string, updates: Partial<DAGNode>): void {
    const node = this.dag.nodes.find((n) => n.task_id === taskId);
    if (node) {
      Object.assign(node, updates);
    }
    this.dag.updated_at = new Date().toISOString();
  }

  /**
   * Update ready status for all tasks
   */
  private updateReadyTasks(): void {
    for (const node of this.dag.nodes) {
      const status = this.taskStatus.get(node.task_id);

      // Only pending tasks can become ready
      if (status !== 'pending') continue;

      // Check if all dependencies are completed
      const deps = this.dependencyMap.get(node.task_id);
      if (!deps || deps.size === 0) {
        this.taskStatus.set(node.task_id, 'ready');
        this.updateNode(node.task_id, { status: 'ready' });
        continue;
      }

      let allDepsCompleted = true;
      for (const depId of deps) {
        const depStatus = this.taskStatus.get(depId);
        if (depStatus !== 'completed') {
          allDepsCompleted = false;
          break;
        }
      }

      if (allDepsCompleted) {
        this.taskStatus.set(node.task_id, 'ready');
        this.updateNode(node.task_id, { status: 'ready' });
      }
    }
  }

  /**
   * Cancel all tasks that depend on the given task
   */
  private cancelDependentTasks(taskId: string): void {
    const dependents = this.dependentMap.get(taskId);
    if (!dependents) return;

    for (const depId of dependents) {
      const status = this.taskStatus.get(depId);
      if (status === 'pending' || status === 'ready') {
        this.markCancelled(depId);
        // Recursively cancel dependents
        this.cancelDependentTasks(depId);
      }
    }
  }

  /**
   * Check if all tasks are complete (completed, failed, or cancelled)
   */
  isComplete(): boolean {
    for (const status of this.taskStatus.values()) {
      if (status === 'pending' || status === 'ready' || status === 'running') {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if any tasks are still running
   */
  hasRunningTasks(): boolean {
    for (const status of this.taskStatus.values()) {
      if (status === 'running') {
        return true;
      }
    }
    return false;
  }

  /**
   * Get progress information
   */
  getProgress(): DAGProgress {
    let completed = 0;
    let failed = 0;
    let running = 0;
    let ready = 0;
    let pending = 0;

    for (const status of this.taskStatus.values()) {
      switch (status) {
        case 'completed':
          completed++;
          break;
        case 'failed':
        case 'cancelled':
          failed++;
          break;
        case 'running':
          running++;
          break;
        case 'ready':
          ready++;
          break;
        case 'pending':
          pending++;
          break;
      }
    }

    const total = this.dag.nodes.length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    return {
      total,
      completed,
      failed,
      running,
      ready,
      pending,
      percentage,
    };
  }

  /**
   * Get the current DAG state
   */
  getDAG(): DAG {
    return this.dag;
  }

  /**
   * Get a specific node
   */
  getNode(taskId: string): DAGNode | undefined {
    return this.dag.nodes.find((n) => n.task_id === taskId);
  }

  /**
   * Get task status
   */
  getTaskStatus(taskId: string): DAGNodeStatus | undefined {
    return this.taskStatus.get(taskId);
  }

  /**
   * Check for circular dependencies (should be called during DAG creation)
   */
  static validateDAG(dag: DAG): { valid: boolean; error?: string } {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    // Build adjacency list
    const adjacency = new Map<string, string[]>();
    for (const node of dag.nodes) {
      adjacency.set(node.task_id, node.dependencies);
    }

    function hasCycle(taskId: string): boolean {
      visited.add(taskId);
      recursionStack.add(taskId);

      const deps = adjacency.get(taskId) ?? [];
      for (const dep of deps) {
        if (!visited.has(dep)) {
          if (hasCycle(dep)) {
            return true;
          }
        } else if (recursionStack.has(dep)) {
          return true;
        }
      }

      recursionStack.delete(taskId);
      return false;
    }

    for (const node of dag.nodes) {
      if (!visited.has(node.task_id)) {
        if (hasCycle(node.task_id)) {
          return { valid: false, error: 'Circular dependency detected' };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Get topological order of tasks
   */
  getTopologicalOrder(): string[] {
    const order: string[] = [];
    const visited = new Set<string>();

    const visit = (taskId: string) => {
      if (visited.has(taskId)) return;
      visited.add(taskId);

      const deps = this.dependencyMap.get(taskId) ?? new Set();
      for (const dep of deps) {
        visit(dep);
      }

      order.push(taskId);
    };

    for (const node of this.dag.nodes) {
      visit(node.task_id);
    }

    return order;
  }

  /**
   * Get critical path (longest path through DAG)
   */
  getCriticalPath(): string[] {
    const order = this.getTopologicalOrder();
    const distances = new Map<string, number>();
    const predecessors = new Map<string, string>();

    // Initialize distances
    for (const taskId of order) {
      distances.set(taskId, 0);
    }

    // Calculate longest paths
    for (const taskId of order) {
      const dependents = this.dependentMap.get(taskId) ?? new Set();
      const currentDist = distances.get(taskId) ?? 0;

      for (const depId of dependents) {
        const node = this.dag.nodes.find((n) => n.task_id === depId);
        const weight = node?.estimated_duration_ms ?? 1;
        const newDist = currentDist + weight;

        if (newDist > (distances.get(depId) ?? 0)) {
          distances.set(depId, newDist);
          predecessors.set(depId, taskId);
        }
      }
    }

    // Find the end node with maximum distance
    let maxDist = 0;
    let endNode = '';
    for (const [taskId, dist] of distances) {
      if (dist > maxDist) {
        maxDist = dist;
        endNode = taskId;
      }
    }

    // Reconstruct path
    const path: string[] = [];
    let current = endNode;
    while (current) {
      path.unshift(current);
      current = predecessors.get(current) ?? '';
    }

    return path;
  }
}

/**
 * Create a new DAG scheduler
 */
export function createDAGScheduler(dag: DAG): DAGScheduler {
  return new DAGScheduler(dag);
}
