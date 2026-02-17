import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceManager } from '../src/manager.js';

describe('WorkspaceManager', () => {
  let baseDir: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-test-'));
    manager = new WorkspaceManager({ baseDir });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a workspace with default directories', async () => {
      const handle = await manager.create('test-task');

      expect(handle.id).toMatch(/^test-task-/);
      expect(handle.createdAt).toBeInstanceOf(Date);

      // Verify all default dirs exist
      for (const dir of ['input', 'output', 'resources', 'scratch']) {
        const stat = await fs.stat(path.join(handle.path, dir));
        expect(stat.isDirectory()).toBe(true);
      }
    });

    it('creates additional directories when specified', async () => {
      const handle = await manager.create('test-task', {
        additionalDirs: ['skills', 'logs'],
      });

      for (const dir of ['input', 'output', 'resources', 'scratch', 'skills', 'logs']) {
        const stat = await fs.stat(path.join(handle.path, dir));
        expect(stat.isDirectory()).toBe(true);
      }
    });

    it('writes workspace metadata', async () => {
      const handle = await manager.create('my-task');
      const metaRaw = await fs.readFile(path.join(handle.path, '.workspace.json'), 'utf-8');
      const meta = JSON.parse(metaRaw);

      expect(meta.id).toBe(handle.id);
      expect(meta.taskType).toBe('my-task');
      expect(meta.dirs).toEqual(['input', 'output', 'resources', 'scratch']);
    });

    it('includes additional dirs in metadata', async () => {
      const handle = await manager.create('my-task', { additionalDirs: ['custom'] });
      const metaRaw = await fs.readFile(path.join(handle.path, '.workspace.json'), 'utf-8');
      const meta = JSON.parse(metaRaw);

      expect(meta.dirs).toEqual(['input', 'output', 'resources', 'scratch', 'custom']);
    });
  });

  describe('cleanup', () => {
    it('removes the workspace directory', async () => {
      const handle = await manager.create('test-task');
      await manager.cleanup(handle);

      await expect(fs.access(handle.path)).rejects.toThrow();
    });
  });

  describe('list', () => {
    it('returns empty array when no workspaces exist', async () => {
      const handles = await manager.list();
      expect(handles).toEqual([]);
    });

    it('lists all created workspaces', async () => {
      await manager.create('task-a');
      await manager.create('task-b');

      const handles = await manager.list();
      expect(handles).toHaveLength(2);
      expect(handles.map((h) => h.id).sort()).toEqual(
        expect.arrayContaining([expect.stringMatching(/^task-a-/), expect.stringMatching(/^task-b-/)]),
      );
    });

    it('does not list cleaned-up workspaces', async () => {
      const a = await manager.create('task-a');
      await manager.create('task-b');
      await manager.cleanup(a);

      const handles = await manager.list();
      expect(handles).toHaveLength(1);
      expect(handles[0].id).toMatch(/^task-b-/);
    });
  });

  describe('pruneStale', () => {
    it('removes workspaces older than maxAgeMs', async () => {
      await manager.create('old-task');

      // Prune everything older than 0ms (i.e. everything)
      const pruned = await manager.pruneStale(0);
      expect(pruned).toBe(1);

      const handles = await manager.list();
      expect(handles).toHaveLength(0);
    });

    it('keeps workspaces newer than maxAgeMs', async () => {
      await manager.create('new-task');

      // Prune things older than 1 hour
      const pruned = await manager.pruneStale(60 * 60 * 1000);
      expect(pruned).toBe(0);

      const handles = await manager.list();
      expect(handles).toHaveLength(1);
    });
  });
});
