/**
 * Task execution types for agent-workspace.
 *
 * Defines the generic TaskTemplate, TaskRunner, and AgentBackend interfaces
 * that enable any package to define workspace-based agent tasks without
 * depending on a specific agent runtime (cognitive-core, OpenHive, etc.).
 */

import type { WorkspaceHandle } from '../handle.js';
import type { OutputSpec } from '../types.js';

// ── Complexity ────────────────────────────────────────────────────────────────

/** Complexity level determines whether to use heuristic or agentic execution. */
export type TaskComplexity =
  | 'heuristic'    // Use heuristicFallback(), no agent needed
  | 'lightweight'  // Agent with small budget, simple workspace
  | 'standard'     // Agent with moderate budget, full workspace
  | 'thorough';    // Agent with large budget, full workspace, more time

// ── Agent Backend ─────────────────────────────────────────────────────────────

/** Configuration for spawning an agent to execute a task. */
export interface AgentSpawnConfig {
  /** Agent type identifier (e.g., 'claude-code'). */
  agentType: string;
  /** The task prompt for the agent. */
  prompt: string;
  /** Working directory — the workspace path. */
  cwd: string;
  /** Optional system context / instructions. */
  systemContext?: string;
  /** Execution timeout in milliseconds. */
  timeout?: number;
  /** Skills loaded into the workspace. */
  skills?: SkillSpec[];
}

/** Result returned by an agent after execution. */
export interface AgentResult {
  /** Whether the agent completed successfully. */
  success: boolean;
  /** Raw text output from the agent. */
  output: string;
  /** Optional structured data from the agent. */
  structured?: unknown;
  /** Execution metrics. */
  metrics?: {
    totalTimeMs: number;
    tokensUsed?: number;
    toolCalls?: number;
  };
}

/**
 * Minimal agent backend interface.
 *
 * Implementations wrap a specific agent runtime:
 * - OpenHive's SwarmAgentDelegate (MAP dispatch)
 * - cognitive-core's AgentManager (subprocess/ACP)
 * - A mock backend for testing
 */
export interface AgentBackend {
  spawn(config: AgentSpawnConfig): Promise<AgentResult>;
}

// ── Skills & Resources ────────────────────────────────────────────────────────

/** A skill to load into the workspace's skills/ directory. */
export interface SkillSpec {
  /** Skill name (used as directory name under skills/). */
  name: string;
  /** Skill content (typically SKILL.md markdown). */
  content: string;
}

/** A supplementary resource for the workspace's resources/ directory. */
export interface ResourceSpec {
  /** How to populate this resource. */
  type: 'file' | 'symlink' | 'directory';
  /** Path relative to the resources/ directory. */
  path: string;
  /** Source content (for 'file') or source path (for 'symlink'/'directory'). */
  source: string;
}

// ── Task Template ─────────────────────────────────────────────────────────────

/**
 * Declarative recipe for an agent workspace task.
 *
 * Defines the full lifecycle: what goes into the workspace, what the agent
 * should do, what output is expected, and how to collect results.
 *
 * @typeParam TInput - Typed input data for this task
 * @typeParam TOutput - Typed output the agent produces
 */
export interface TaskTemplate<TInput, TOutput> {
  /** Unique identifier for this task type. */
  taskType: string;
  /** Domain for categorization and knowledge scoping. */
  domain: string;
  /** Human-readable description of what this task does. */
  description: string;

  // --- Complexity ---

  /** Assess whether this input needs an agent or can be handled heuristically. */
  assessComplexity(input: TInput): TaskComplexity;
  /** Optional fast path for simple inputs (called when assessComplexity returns 'heuristic'). */
  heuristicFallback?(input: TInput): Promise<TOutput>;

  // --- Workspace Setup ---

  /** Populate the workspace filesystem from typed input. */
  prepareWorkspace(input: TInput, handle: WorkspaceHandle): Promise<void>;
  /** Build the natural language task prompt for the agent. */
  buildTaskPrompt(input: TInput): string;
  /** Skills to load into the workspace skills/ directory. */
  getSkills(input: TInput): SkillSpec[];
  /** Supplementary resources for the workspace resources/ directory. */
  getResources(input: TInput): ResourceSpec[];

  // --- Output ---

  /** Specification of expected output files for validation. */
  outputConfig: OutputSpec;
  /** Read and return typed output from the workspace after agent execution. */
  collectOutput(handle: WorkspaceHandle): Promise<TOutput>;

  // --- Agent Config ---

  /** Agent type to use (defaults to 'claude-code'). */
  agentType?: string;
  /** Execution timeout in milliseconds. */
  timeout?: number;
}

// ── Runner Config & Hooks ─────────────────────────────────────────────────────

/** Configuration for TaskRunner. */
export interface TaskRunnerConfig {
  /** Default timeout for agent execution in milliseconds. */
  defaultTimeout?: number;
  /** Additional workspace directories beyond the defaults. */
  additionalDirs?: string[];
}

/**
 * Lifecycle hooks for extending TaskRunner behavior.
 *
 * Passed per-run() call so consumers (e.g., cognitive-core) can inject
 * template-specific logic without subclassing the runner.
 */
export interface TaskRunnerHooks<TInput = unknown, TOutput = unknown> {
  /** Called before agent spawn — can modify the spawn config (e.g., inject knowledge). */
  onBeforeSpawn?(config: AgentSpawnConfig, handle: WorkspaceHandle, input: TInput): Promise<AgentSpawnConfig>;
  /** Called after agent spawn — can process the result (e.g., route trajectory). */
  onAfterSpawn?(result: AgentResult, handle: WorkspaceHandle): Promise<void>;
  /** Called after output collection — can store/process results. */
  onComplete?(output: TOutput, input: TInput): Promise<void>;
}

// ── Task Result ───────────────────────────────────────────────────────────────

/** Result of running a task template. */
export interface TaskResult<TOutput> {
  /** The typed output collected from the workspace. */
  output: TOutput;
  /** Whether the task used heuristic fallback or agentic execution. */
  method: 'heuristic' | 'agentic';
  /** Execution metrics (only present for agentic execution). */
  metrics?: {
    totalTimeMs: number;
    tokensUsed?: number;
    toolCalls?: number;
  };
}

// ── Errors ────────────────────────────────────────────────────────────────────

/** Error thrown when task output validation fails. */
export class TaskOutputError extends Error {
  constructor(
    public readonly taskType: string,
    public readonly cause: Error,
  ) {
    super(`Task "${taskType}" output validation failed: ${cause.message}`);
    this.name = 'TaskOutputError';
  }
}
