import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { buildRuntimeConfig, SandboxHandle } from '../src/sandbox.js';
import { WorkspaceHandle } from '../src/handle.js';
import { WorkspaceManager } from '../src/manager.js';
import type { SandboxConfig } from '../src/types.js';

describe('buildRuntimeConfig', () => {
  const workspacePath = '/tmp/agent-workspaces/test-123';

  it('builds config with defaults when only enabled is set', () => {
    const config: SandboxConfig = { enabled: true };
    const result = buildRuntimeConfig(config, workspacePath);

    expect(result).toEqual({
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: false,
      },
      filesystem: {
        denyRead: [],
        allowRead: [],
        allowWrite: [workspacePath],
        denyWrite: [],
      },
      enableWeakerNestedSandbox: false,
    });
  });

  it('includes workspace path in allowWrite', () => {
    const config: SandboxConfig = { enabled: true };
    const result = buildRuntimeConfig(config, workspacePath) as any;

    expect(result.filesystem.allowWrite).toContain(workspacePath);
  });

  it('merges extra write paths with workspace path', () => {
    const config: SandboxConfig = {
      enabled: true,
      filesystem: {
        extraWritePaths: ['/tmp/shared', '/var/data'],
      },
    };
    const result = buildRuntimeConfig(config, workspacePath) as any;

    expect(result.filesystem.allowWrite).toEqual([
      workspacePath,
      '/tmp/shared',
      '/var/data',
    ]);
  });

  it('passes through network config', () => {
    const config: SandboxConfig = {
      enabled: true,
      network: {
        allowedDomains: ['github.com', '*.npmjs.org'],
        deniedDomains: ['evil.com'],
        allowLocalBinding: true,
      },
    };
    const result = buildRuntimeConfig(config, workspacePath) as any;

    expect(result.network).toEqual({
      allowedDomains: ['github.com', '*.npmjs.org'],
      deniedDomains: ['evil.com'],
      allowLocalBinding: true,
    });
  });

  it('passes through filesystem deny/allow config', () => {
    const config: SandboxConfig = {
      enabled: true,
      filesystem: {
        denyRead: ['~/.ssh'],
        allowRead: ['~/.ssh/known_hosts'],
        denyWrite: ['.env'],
      },
    };
    const result = buildRuntimeConfig(config, workspacePath) as any;

    expect(result.filesystem.denyRead).toEqual(['~/.ssh']);
    expect(result.filesystem.allowRead).toEqual(['~/.ssh/known_hosts']);
    expect(result.filesystem.denyWrite).toEqual(['.env']);
  });

  it('passes enableWeakerNestedSandbox', () => {
    const config: SandboxConfig = {
      enabled: true,
      enableWeakerNestedSandbox: true,
    };
    const result = buildRuntimeConfig(config, workspacePath) as any;

    expect(result.enableWeakerNestedSandbox).toBe(true);
  });
});

describe('SandboxHandle', () => {
  function createMockManager() {
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockResolvedValue(undefined),
      wrapWithSandbox: vi.fn().mockResolvedValue('sandbox-wrapped: echo hello'),
      isSandboxingEnabled: vi.fn().mockReturnValue(true),
      isSupportedPlatform: vi.fn().mockReturnValue(true),
      cleanupAfterCommand: vi.fn(),
      checkDependencies: vi.fn().mockResolvedValue({ errors: [], warnings: [] }),
    };
  }

  it('wraps commands via the manager', async () => {
    const mock = createMockManager();
    const handle = new SandboxHandle(mock as any);

    const result = await handle.wrapCommand('echo hello');
    expect(result).toBe('sandbox-wrapped: echo hello');
    expect(mock.wrapWithSandbox).toHaveBeenCalledWith('echo hello', undefined, undefined, undefined);
  });

  it('passes abort signal to wrapWithSandbox', async () => {
    const mock = createMockManager();
    const handle = new SandboxHandle(mock as any);
    const ac = new AbortController();

    await handle.wrapCommand('ls', ac.signal);
    expect(mock.wrapWithSandbox).toHaveBeenCalledWith('ls', undefined, undefined, ac.signal);
  });

  it('starts active and becomes inactive after destroy', async () => {
    const mock = createMockManager();
    const handle = new SandboxHandle(mock as any);

    expect(handle.active).toBe(true);

    await handle.destroy();
    expect(handle.active).toBe(false);
    expect(mock.reset).toHaveBeenCalledOnce();
  });

  it('throws on wrapCommand after destroy', async () => {
    const mock = createMockManager();
    const handle = new SandboxHandle(mock as any);

    await handle.destroy();
    await expect(handle.wrapCommand('echo hi')).rejects.toThrow('Sandbox session has been destroyed.');
  });

  it('destroy is idempotent', async () => {
    const mock = createMockManager();
    const handle = new SandboxHandle(mock as any);

    await handle.destroy();
    await handle.destroy();
    expect(mock.reset).toHaveBeenCalledOnce();
  });

  it('cleanupAfterCommand delegates to manager', () => {
    const mock = createMockManager();
    const handle = new SandboxHandle(mock as any);

    handle.cleanupAfterCommand();
    expect(mock.cleanupAfterCommand).toHaveBeenCalledOnce();
  });

  it('cleanupAfterCommand is no-op after destroy', async () => {
    const mock = createMockManager();
    const handle = new SandboxHandle(mock as any);

    await handle.destroy();
    handle.cleanupAfterCommand();
    expect(mock.cleanupAfterCommand).not.toHaveBeenCalled();
  });
});

describe('WorkspaceHandle sandbox integration', () => {
  it('wrapCommand throws when sandbox is not enabled', async () => {
    const handle = new WorkspaceHandle('test-id', '/tmp/test', ['input', 'output'], new Date());

    await expect(handle.wrapCommand('echo hello')).rejects.toThrow(
      'This workspace was not created with sandbox isolation enabled.',
    );
  });

  it('wrapCommand delegates to sandbox handle when present', async () => {
    const mockSandbox = {
      active: true,
      wrapCommand: vi.fn().mockResolvedValue('wrapped: ls'),
      cleanupAfterCommand: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    const handle = new WorkspaceHandle(
      'test-id',
      '/tmp/test',
      ['input', 'output'],
      new Date(),
      mockSandbox as any,
    );

    const result = await handle.wrapCommand('ls');
    expect(result).toBe('wrapped: ls');
    expect(mockSandbox.wrapCommand).toHaveBeenCalledWith('ls', undefined);
  });

  it('exposes sandbox property as undefined when not configured', () => {
    const handle = new WorkspaceHandle('test-id', '/tmp/test', ['input', 'output'], new Date());
    expect(handle.sandbox).toBeUndefined();
  });
});

describe('WorkspaceManager sandbox cleanup', () => {
  let baseDir: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-sandbox-test-'));
    manager = new WorkspaceManager({ baseDir });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('cleanup destroys sandbox when active', async () => {
    const handle = await manager.create('test-task');

    // Attach a mock sandbox to the handle for testing
    const mockSandbox = {
      active: true,
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(handle, 'sandbox', { value: mockSandbox });

    await manager.cleanup(handle);

    expect(mockSandbox.destroy).toHaveBeenCalledOnce();
    await expect(fs.access(handle.path)).rejects.toThrow();
  });

  it('cleanup skips sandbox destroy when not active', async () => {
    const handle = await manager.create('test-task');

    const mockSandbox = {
      active: false,
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(handle, 'sandbox', { value: mockSandbox });

    await manager.cleanup(handle);

    expect(mockSandbox.destroy).not.toHaveBeenCalled();
  });

  it('cleanup works normally without sandbox', async () => {
    const handle = await manager.create('test-task');
    await manager.cleanup(handle);
    await expect(fs.access(handle.path)).rejects.toThrow();
  });
});
