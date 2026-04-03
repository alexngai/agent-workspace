import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { TaskRunner } from '../src/task/runner.js';
import { WorkspaceManager } from '../src/manager.js';
import type {
  TaskTemplate,
  AgentBackend,
  AgentResult,
  AgentSpawnConfig,
  TaskRunnerHooks,
} from '../src/task/types.js';

// ── Test Helpers ──────────────────────────────────────────────────────────────

interface TestInput {
  value: string;
}

interface TestOutput {
  result: string;
  score: number;
}

function createMockBackend(
  handler?: (config: AgentSpawnConfig) => Promise<AgentResult>,
): AgentBackend {
  return {
    spawn: handler ?? (async (config) => {
      // Default: write output file to workspace
      const outputDir = path.join(config.cwd, 'output');
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(
        path.join(outputDir, 'result.json'),
        JSON.stringify({ result: `processed: ${config.prompt}`, score: 0.95 }),
      );
      return {
        success: true,
        output: JSON.stringify({ result: `processed: ${config.prompt}`, score: 0.95 }),
        metrics: { totalTimeMs: 50, tokensUsed: 100, toolCalls: 2 },
      };
    }),
  };
}

function createTestTemplate(
  overrides?: Partial<TaskTemplate<TestInput, TestOutput>>,
): TaskTemplate<TestInput, TestOutput> {
  return {
    taskType: 'test-task',
    domain: 'testing',
    description: 'A test task template',

    assessComplexity: () => 'lightweight',

    prepareWorkspace: async (input, handle) => {
      await handle.writeJson('input', 'data.json', { value: input.value });
    },

    buildTaskPrompt: (input) => `Process this value: ${input.value}`,

    getSkills: () => [],
    getResources: () => [],

    outputConfig: {
      files: [{
        path: 'result.json',
        format: 'json' as const,
        required: true,
        description: 'Task result',
      }],
    },

    collectOutput: async (handle) => {
      return handle.readJson<TestOutput>('output', 'result.json');
    },

    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TaskRunner', () => {
  let workspaceManager: WorkspaceManager;

  beforeEach(() => {
    workspaceManager = new WorkspaceManager({
      prefix: 'task-runner-test',
    });
  });

  afterEach(async () => {
    await workspaceManager.pruneStale(0);
  });

  it('should run a template through the full lifecycle', async () => {
    const backend = createMockBackend();
    const runner = new TaskRunner(workspaceManager, backend);
    const template = createTestTemplate();

    const result = await runner.run(template, { value: 'hello' });

    expect(result.method).toBe('agentic');
    expect(result.output.result).toContain('processed');
    expect(result.output.score).toBe(0.95);
    expect(result.metrics?.totalTimeMs).toBeGreaterThan(0);
  });

  it('should use heuristic fallback when complexity is heuristic', async () => {
    const backend = createMockBackend();
    const runner = new TaskRunner(workspaceManager, backend);
    const template = createTestTemplate({
      assessComplexity: () => 'heuristic',
      heuristicFallback: async (input) => ({
        result: `heuristic: ${input.value}`,
        score: 1.0,
      }),
    });

    const result = await runner.run(template, { value: 'simple' });

    expect(result.method).toBe('heuristic');
    expect(result.output.result).toBe('heuristic: simple');
    expect(result.output.score).toBe(1.0);
  });

  it('should not use heuristic if no fallback is provided', async () => {
    const backend = createMockBackend();
    const runner = new TaskRunner(workspaceManager, backend);
    const template = createTestTemplate({
      assessComplexity: () => 'heuristic',
      // No heuristicFallback — should fall through to agentic
    });

    const result = await runner.run(template, { value: 'no-fallback' });
    expect(result.method).toBe('agentic');
  });

  it('should populate skills in the workspace', async () => {
    let capturedCwd = '';
    const backend = createMockBackend(async (config) => {
      capturedCwd = config.cwd;
      // Verify skills were written
      const skillPath = path.join(config.cwd, 'skills', 'test-skill', 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
      expect(fs.readFileSync(skillPath, 'utf-8')).toBe('# Test Skill\nDo the thing.');

      // Write output
      const outputDir = path.join(config.cwd, 'output');
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({ result: 'ok', score: 1 }));

      return { success: true, output: '{}' };
    });

    const runner = new TaskRunner(workspaceManager, backend);
    const template = createTestTemplate({
      getSkills: () => [{ name: 'test-skill', content: '# Test Skill\nDo the thing.' }],
    });

    await runner.run(template, { value: 'with-skills' });
    expect(capturedCwd).not.toBe('');
  });

  it('should populate resources in the workspace', async () => {
    const backend = createMockBackend(async (config) => {
      // Verify resource was written
      const resourcePath = path.join(config.cwd, 'resources', 'context.txt');
      expect(fs.existsSync(resourcePath)).toBe(true);
      expect(fs.readFileSync(resourcePath, 'utf-8')).toBe('background context');

      const outputDir = path.join(config.cwd, 'output');
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({ result: 'ok', score: 1 }));

      return { success: true, output: '{}' };
    });

    const runner = new TaskRunner(workspaceManager, backend);
    const template = createTestTemplate({
      getResources: () => [{ type: 'file' as const, path: 'context.txt', source: 'background context' }],
    });

    await runner.run(template, { value: 'with-resources' });
  });

  it('should call onBeforeSpawn hook and allow config modification', async () => {
    const backend = createMockBackend();
    const runner = new TaskRunner(workspaceManager, backend);
    const template = createTestTemplate();

    let hookCalled = false;
    const hooks: TaskRunnerHooks<TestInput, TestOutput> = {
      onBeforeSpawn: async (config, _handle, input) => {
        hookCalled = true;
        expect(input.value).toBe('hooked');
        return { ...config, systemContext: 'injected knowledge' };
      },
    };

    await runner.run(template, { value: 'hooked' }, hooks);
    expect(hookCalled).toBe(true);
  });

  it('should call onAfterSpawn hook with agent result', async () => {
    const backend = createMockBackend();
    const runner = new TaskRunner(workspaceManager, backend);
    const template = createTestTemplate();

    let capturedResult: AgentResult | null = null;
    const hooks: TaskRunnerHooks<TestInput, TestOutput> = {
      onAfterSpawn: async (result) => {
        capturedResult = result;
      },
    };

    await runner.run(template, { value: 'test' }, hooks);
    expect(capturedResult).not.toBeNull();
    expect(capturedResult!.success).toBe(true);
  });

  it('should call onComplete hook with collected output', async () => {
    const backend = createMockBackend();
    const runner = new TaskRunner(workspaceManager, backend);
    const template = createTestTemplate();

    let capturedOutput: TestOutput | null = null;
    const hooks: TaskRunnerHooks<TestInput, TestOutput> = {
      onComplete: async (output, input) => {
        capturedOutput = output;
        expect(input.value).toBe('complete');
      },
    };

    await runner.run(template, { value: 'complete' }, hooks);
    expect(capturedOutput).not.toBeNull();
    expect(capturedOutput!.score).toBe(0.95);
  });

  it('should throw TaskOutputError when output validation fails', async () => {
    const backend = createMockBackend(async (config) => {
      // Don't write any output files
      return { success: true, output: '' };
    });

    const runner = new TaskRunner(workspaceManager, backend);
    const template = createTestTemplate();

    await expect(runner.run(template, { value: 'no-output' }))
      .rejects.toThrow('output validation failed');
  });

  it('should cleanup workspace even on error', async () => {
    const backend = createMockBackend(async () => {
      throw new Error('Agent crashed');
    });

    const runner = new TaskRunner(workspaceManager, backend);
    const template = createTestTemplate();

    await expect(runner.run(template, { value: 'crash' }))
      .rejects.toThrow('Agent crashed');

    // Workspace should be cleaned up
    const workspaces = await workspaceManager.list();
    expect(workspaces.length).toBe(0);
  });

  it('should pass timeout from template to spawn config', async () => {
    let capturedTimeout: number | undefined;
    const backend = createMockBackend(async (config) => {
      capturedTimeout = config.timeout;
      const outputDir = path.join(config.cwd, 'output');
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({ result: 'ok', score: 1 }));
      return { success: true, output: '{}' };
    });

    const runner = new TaskRunner(workspaceManager, backend);
    const template = createTestTemplate({ timeout: 30_000 });

    await runner.run(template, { value: 'timed' });
    expect(capturedTimeout).toBe(30_000);
  });

  it('should use defaultTimeout from runner config when template has no timeout', async () => {
    let capturedTimeout: number | undefined;
    const backend = createMockBackend(async (config) => {
      capturedTimeout = config.timeout;
      const outputDir = path.join(config.cwd, 'output');
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({ result: 'ok', score: 1 }));
      return { success: true, output: '{}' };
    });

    const runner = new TaskRunner(workspaceManager, backend, { defaultTimeout: 60_000 });
    const template = createTestTemplate();

    await runner.run(template, { value: 'default-timeout' });
    expect(capturedTimeout).toBe(60_000);
  });
});
