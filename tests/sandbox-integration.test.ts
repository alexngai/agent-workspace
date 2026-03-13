import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceManager } from '../src/manager.js';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '../src/types.js';

/**
 * Integration tests that exercise the real @anthropic-ai/sandbox-runtime.
 * These require bubblewrap (bwrap) and socat to be installed on Linux.
 */

const isSupported = SandboxManager.isSupportedPlatform();

describe.runIf(isSupported)('Sandbox integration (real runtime)', () => {
  let baseDir: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-sb-int-'));
    manager = new WorkspaceManager({ baseDir });
  });

  afterEach(async () => {
    // Reset sandbox state between tests (SandboxManager is a singleton)
    try { await SandboxManager.reset(); } catch { /* already reset */ }
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('creates a sandboxed workspace and wraps commands', async () => {
    const handle = await manager.create('sandboxed-task', {
      sandbox: {
        enabled: true,
        network: { allowedDomains: [], deniedDomains: [] },
      },
    });

    expect(handle.sandbox).toBeDefined();
    expect(handle.sandbox!.active).toBe(true);

    const wrapped = await handle.wrapCommand('echo hello');
    expect(wrapped).toContain('bwrap');

    const output = execSync(wrapped, { shell: true, encoding: 'utf-8' }).trim();
    expect(output).toBe('hello');

    await manager.cleanup(handle);
    expect(handle.sandbox!.active).toBe(false);
  });

  it('allows writing to workspace directories', async () => {
    const handle = await manager.create('write-test', {
      sandbox: {
        enabled: true,
        network: { allowedDomains: [], deniedDomains: [] },
      },
    });

    const testFile = path.join(handle.outputDir, 'result.txt');
    const wrapped = await handle.wrapCommand(`echo "sandbox-output" > ${testFile}`);
    execSync(wrapped, { shell: true });

    const content = await fs.readFile(testFile, 'utf-8');
    expect(content.trim()).toBe('sandbox-output');

    await manager.cleanup(handle);
  });

  it('blocks writing outside workspace directories', async () => {
    const handle = await manager.create('block-test', {
      sandbox: {
        enabled: true,
        network: { allowedDomains: [], deniedDomains: [] },
      },
    });

    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-outside-'));
    const outsideFile = path.join(outsideDir, 'should-not-exist.txt');

    const wrapped = await handle.wrapCommand(`echo "hacked" > ${outsideFile}`);

    let blocked = false;
    try {
      execSync(wrapped, { shell: true, stdio: 'pipe' });
      // Command might succeed but file shouldn't be created outside sandbox
      try {
        await fs.access(outsideFile);
        // File exists — sandbox didn't block it
      } catch {
        blocked = true;
      }
    } catch {
      // Command itself failed — sandbox blocked it
      blocked = true;
    }

    expect(blocked).toBe(true);

    await fs.rm(outsideDir, { recursive: true, force: true });
    await manager.cleanup(handle);
  });

  it('sandbox handles all default workspace sections', async () => {
    const handle = await manager.create('sections-test', {
      sandbox: {
        enabled: true,
        network: { allowedDomains: [], deniedDomains: [] },
      },
    });

    for (const section of ['input', 'output', 'resources', 'scratch']) {
      const sectionDir = handle.dir(section);
      const testFile = path.join(sectionDir, 'test.txt');
      const wrapped = await handle.wrapCommand(`echo "${section}" > ${testFile}`);
      execSync(wrapped, { shell: true });

      const content = await fs.readFile(testFile, 'utf-8');
      expect(content.trim()).toBe(section);
    }

    await manager.cleanup(handle);
  });

  it('sandbox handles additional directories', async () => {
    const handle = await manager.create('extra-dirs', {
      additionalDirs: ['logs', 'cache'],
      sandbox: {
        enabled: true,
        network: { allowedDomains: [], deniedDomains: [] },
      },
    });

    const logsFile = path.join(handle.dir('logs'), 'app.log');
    const wrapped = await handle.wrapCommand(`echo "log entry" > ${logsFile}`);
    execSync(wrapped, { shell: true });

    const content = await fs.readFile(logsFile, 'utf-8');
    expect(content.trim()).toBe('log entry');

    await manager.cleanup(handle);
  });

  it('supports extra write paths outside workspace', async () => {
    const extraDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-extra-'));

    const handle = await manager.create('extra-write', {
      sandbox: {
        enabled: true,
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: {
          extraWritePaths: [extraDir],
        },
      },
    });

    const extraFile = path.join(extraDir, 'allowed.txt');
    const wrapped = await handle.wrapCommand(`echo "allowed" > ${extraFile}`);
    execSync(wrapped, { shell: true });

    const content = await fs.readFile(extraFile, 'utf-8');
    expect(content.trim()).toBe('allowed');

    await fs.rm(extraDir, { recursive: true, force: true });
    await manager.cleanup(handle);
  });

  it('wrapCommand throws after sandbox is destroyed', async () => {
    const handle = await manager.create('destroy-test', {
      sandbox: {
        enabled: true,
        network: { allowedDomains: [], deniedDomains: [] },
      },
    });

    await handle.sandbox!.destroy();

    await expect(handle.wrapCommand('echo hi')).rejects.toThrow(
      'Sandbox session has been destroyed.',
    );

    // cleanup still works (sandbox already destroyed)
    await manager.cleanup(handle);
  });

  it('cleanupAfterCommand does not break subsequent commands', async () => {
    const handle = await manager.create('cleanup-cmd', {
      sandbox: {
        enabled: true,
        network: { allowedDomains: [], deniedDomains: [] },
      },
    });

    // Run a command, cleanup, then run another
    const wrapped1 = await handle.wrapCommand('echo first');
    execSync(wrapped1, { shell: true });
    handle.sandbox!.cleanupAfterCommand();

    const wrapped2 = await handle.wrapCommand('echo second');
    const output = execSync(wrapped2, { shell: true, encoding: 'utf-8' }).trim();
    expect(output).toBe('second');

    await manager.cleanup(handle);
  });

  it('non-sandboxed workspace has no sandbox property', async () => {
    const handle = await manager.create('no-sandbox');

    expect(handle.sandbox).toBeUndefined();
    await expect(handle.wrapCommand('echo hi')).rejects.toThrow(
      'This workspace was not created with sandbox isolation enabled.',
    );

    await manager.cleanup(handle);
  });

  it('workspace I/O still works alongside sandbox', async () => {
    const handle = await manager.create('io-test', {
      sandbox: {
        enabled: true,
        network: { allowedDomains: [], deniedDomains: [] },
      },
    });

    // Use normal workspace I/O (not sandboxed — goes through Node fs directly)
    await handle.writeJson('output', 'data.json', { result: 42 });
    const data = await handle.readJson<{ result: number }>('output', 'data.json');
    expect(data.result).toBe(42);

    // Sandboxed command can also read the file
    const filePath = path.join(handle.outputDir, 'data.json');
    const wrapped = await handle.wrapCommand(`cat ${filePath}`);
    const output = execSync(wrapped, { shell: true, encoding: 'utf-8' }).trim();
    expect(JSON.parse(output)).toEqual({ result: 42 });

    await manager.cleanup(handle);
  });
});
