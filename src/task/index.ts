export { TaskRunner } from './runner.js';
export { TaskOutputError } from './types.js';
export type {
  TaskTemplate,
  TaskComplexity,
  AgentBackend,
  AgentSpawnConfig,
  AgentResult,
  SkillSpec,
  ResourceSpec,
  TaskRunnerConfig,
  TaskRunnerHooks,
  TaskResult,
} from './types.js';

// Protocol: wire format for remote workspace task execution
export { WORKSPACE_METHODS, WORKSPACE_METHODS_LEGACY } from './protocol.js';
export type { WorkspaceExecuteParams, WorkspaceResultParams } from './protocol.js';
