/**
 * Workspace Task Execution Protocol
 *
 * Defines the wire format for remote workspace task execution over MAP
 * or any JSON-RPC transport. This is the standard protocol for requesting
 * a remote agent to execute a workspace task.
 *
 * Flow:
 *   Caller → Agent: workspace/task.execute  { request_id, prompt, cwd, ... }
 *   Agent → Caller: workspace/task.result   { request_id, success, output, ... }
 */

// ── Method Names ──────────────────────────────────────────────────────────────

/** Standard JSON-RPC method names for workspace task execution. */
export const WORKSPACE_METHODS = {
  /** Request a remote agent to execute a task in a workspace. */
  EXECUTE: 'x-workspace/task.execute',
  /** Response from the agent with task results. */
  RESULT: 'x-workspace/task.result',
} as const;

/**
 * Legacy method names (OpenHive-specific, deprecated).
 * Kept for backward compatibility during migration.
 */
export const WORKSPACE_METHODS_LEGACY = {
  EXECUTE: 'x-openhive/learning.workspace.execute',
  RESULT: 'x-openhive/learning.workspace.result',
} as const;

// ── Request/Response Types ────────────────────────────────────────────────────

/** Parameters for a workspace/task.execute request. */
export interface WorkspaceExecuteParams {
  /** Unique request ID for correlating request/response. */
  request_id: string;
  /** The task prompt for the agent. */
  prompt: string;
  /** Working directory — the workspace path. */
  cwd: string;
  /** Optional system context / instructions for the agent. */
  system_context?: string;
  /** Execution timeout in milliseconds. */
  timeout?: number;
  /** Task type identifier (from TaskTemplate.taskType). */
  task_type?: string;
  /** Domain for categorization (from TaskTemplate.domain). */
  domain?: string;
}

/** Parameters for a workspace/task.result response. */
export interface WorkspaceResultParams {
  /** Request ID this result corresponds to. */
  request_id: string;
  /** Whether the task completed successfully. */
  success: boolean;
  /** Raw text output from the agent. */
  output: string;
  /** Optional structured data from the agent. */
  structured?: unknown;
  /** Error message if the task failed. */
  error?: string;
  /** Execution duration in milliseconds. */
  duration_ms?: number;
}
