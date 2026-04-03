/**
 * TaskRunner — generic workspace-based task orchestration.
 *
 * Runs a TaskTemplate through the full lifecycle:
 *   1. Assess complexity → heuristic fallback if simple
 *   2. Create workspace
 *   3. Prepare input files
 *   4. Populate skills and resources
 *   5. Spawn agent (via AgentBackend)
 *   6. Validate and collect output
 *   7. Cleanup workspace
 *
 * Extensible via TaskRunnerHooks passed per-run() call.
 */

import { WorkspaceManager } from '../manager.js';
import type { WorkspaceHandle } from '../handle.js';
import {
  TaskOutputError,
  type AgentBackend,
  type AgentSpawnConfig,
  type TaskTemplate,
  type TaskRunnerConfig,
  type TaskRunnerHooks,
  type TaskResult,
} from './types.js';

export class TaskRunner {
  constructor(
    private workspaceManager: WorkspaceManager,
    private backend: AgentBackend,
    private config?: TaskRunnerConfig,
  ) {}

  /**
   * Run a task template with typed input, returning typed output.
   */
  async run<TInput, TOutput>(
    template: TaskTemplate<TInput, TOutput>,
    input: TInput,
    hooks?: TaskRunnerHooks<TInput, TOutput>,
  ): Promise<TaskResult<TOutput>> {
    const startTime = Date.now();

    // Step 1: Complexity assessment
    const complexity = template.assessComplexity(input);

    if (complexity === 'heuristic' && template.heuristicFallback) {
      const output = await template.heuristicFallback(input);
      return {
        output,
        method: 'heuristic',
        metrics: { totalTimeMs: Date.now() - startTime },
      };
    }

    // Step 2: Create workspace
    const additionalDirs = ['skills', ...(this.config?.additionalDirs ?? [])];
    const handle = await this.workspaceManager.create(template.taskType, { additionalDirs });

    try {
      // Step 3: Prepare input files
      await template.prepareWorkspace(input, handle);

      // Step 4: Populate skills
      const skills = template.getSkills(input);
      for (const skill of skills) {
        await handle.writeRaw('skills', `${skill.name}/SKILL.md`, skill.content);
      }

      // Step 5: Populate resources
      const resources = template.getResources(input);
      for (const resource of resources) {
        switch (resource.type) {
          case 'file':
            await handle.writeRaw('resources', resource.path, resource.source);
            break;
          case 'symlink':
            await handle.symlink('resources', resource.path, resource.source);
            break;
          case 'directory':
            await handle.copyDir('resources', resource.path, resource.source);
            break;
        }
      }

      // Step 6: Build spawn config
      const prompt = template.buildTaskPrompt(input);
      let spawnConfig: AgentSpawnConfig = {
        agentType: template.agentType ?? 'claude-code',
        prompt,
        cwd: handle.path,
        timeout: template.timeout ?? this.config?.defaultTimeout,
        skills,
      };

      // Hook: onBeforeSpawn (e.g., inject knowledge)
      if (hooks?.onBeforeSpawn) {
        spawnConfig = await hooks.onBeforeSpawn(spawnConfig, handle, input);
      }

      // Step 7: Spawn agent
      const agentResult = await this.backend.spawn(spawnConfig);

      // Hook: onAfterSpawn (e.g., route trajectory)
      if (hooks?.onAfterSpawn) {
        await hooks.onAfterSpawn(agentResult, handle);
      }

      // Step 8: Validate output
      const validation = await handle.validateOutput(template.outputConfig);
      if (!validation.valid) {
        const errorMessages = validation.errors.map(e => `${e.path}: ${e.message}`).join(', ');
        throw new TaskOutputError(
          template.taskType,
          new Error(`Output validation failed: ${errorMessages}`),
        );
      }

      // Step 9: Collect typed output
      const output = await template.collectOutput(handle);

      // Hook: onComplete (e.g., store results)
      if (hooks?.onComplete) {
        await hooks.onComplete(output, input);
      }

      return {
        output,
        method: 'agentic',
        metrics: {
          totalTimeMs: Date.now() - startTime,
          tokensUsed: agentResult.metrics?.tokensUsed,
          toolCalls: agentResult.metrics?.toolCalls,
        },
      };
    } finally {
      // Step 10: Cleanup
      await this.workspaceManager.cleanup(handle);
    }
  }
}
