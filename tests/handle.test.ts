import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceManager } from '../src/manager.js';
import type { WorkspaceHandle } from '../src/handle.js';

describe('WorkspaceHandle', () => {
  let baseDir: string;
  let manager: WorkspaceManager;
  let handle: WorkspaceHandle;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-handle-'));
    manager = new WorkspaceManager({ baseDir });
    handle = await manager.create('handle-test');
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  describe('dir()', () => {
    it('returns path for known sections', () => {
      expect(handle.dir('input')).toBe(path.join(handle.path, 'input'));
      expect(handle.dir('output')).toBe(path.join(handle.path, 'output'));
      expect(handle.dir('resources')).toBe(path.join(handle.path, 'resources'));
      expect(handle.dir('scratch')).toBe(path.join(handle.path, 'scratch'));
    });

    it('throws for unknown sections', () => {
      expect(() => handle.dir('unknown')).toThrow('Unknown section "unknown"');
    });

    it('works with additional dirs', async () => {
      const h = await manager.create('test', { additionalDirs: ['skills'] });
      expect(h.dir('skills')).toBe(path.join(h.path, 'skills'));
    });
  });

  describe('convenience accessors', () => {
    it('provides inputDir, outputDir, resourcesDir, scratchDir', () => {
      expect(handle.inputDir).toBe(path.join(handle.path, 'input'));
      expect(handle.outputDir).toBe(path.join(handle.path, 'output'));
      expect(handle.resourcesDir).toBe(path.join(handle.path, 'resources'));
      expect(handle.scratchDir).toBe(path.join(handle.path, 'scratch'));
    });
  });

  describe('JSON round-trip', () => {
    it('writes and reads JSON through the handle', async () => {
      await handle.writeJson('input', 'config.json', { model: 'gpt-4' });
      const data = await handle.readJson('input', 'config.json');
      expect(data).toEqual({ model: 'gpt-4' });
    });

    it('writes and reads JSON with schema validation', async () => {
      await handle.writeJson('output', 'result.json', { score: 0.95 });

      const schema = {
        parse(data: unknown) {
          const obj = data as Record<string, number>;
          if (typeof obj.score !== 'number') throw new Error('score required');
          return obj;
        },
      };

      const data = await handle.readJson('output', 'result.json', { schema });
      expect(data).toEqual({ score: 0.95 });
    });
  });

  describe('JSONL round-trip', () => {
    it('writes and reads JSONL through the handle', async () => {
      const items = [{ step: 1 }, { step: 2 }];
      await handle.writeJsonl('scratch', 'log.jsonl', items);
      const result = await handle.readJsonl('scratch', 'log.jsonl');
      expect(result).toEqual(items);
    });
  });

  describe('Markdown round-trip', () => {
    it('writes and reads markdown with frontmatter', async () => {
      await handle.writeMarkdown('output', 'report.md', {
        frontmatter: { title: 'Report', version: 1 },
        body: '# Summary\n\nAll good.',
      });

      const doc = await handle.readMarkdown('output', 'report.md');
      expect(doc.frontmatter).toEqual({ title: 'Report', version: 1 });
      expect(doc.body).toContain('# Summary');
    });
  });

  describe('Raw round-trip', () => {
    it('writes and reads raw content', async () => {
      await handle.writeRaw('scratch', 'notes.txt', 'Remember this');
      const content = await handle.readRaw('scratch', 'notes.txt');
      expect(content).toBe('Remember this');
    });
  });

  describe('listFiles', () => {
    it('lists files in a section', async () => {
      await handle.writeRaw('input', 'a.txt', 'a');
      await handle.writeRaw('input', 'b.txt', 'b');

      const files = await handle.listFiles('input');
      expect(files.sort()).toEqual(['a.txt', 'b.txt']);
    });
  });

  describe('readJsonDir', () => {
    it('reads all JSON files in a subdirectory', async () => {
      await handle.writeJson('output', 'results/a.json', { x: 1 });
      await handle.writeJson('output', 'results/b.json', { x: 2 });

      const map = await handle.readJsonDir('output', 'results');
      expect(map.size).toBe(2);
      expect(map.get('a.json')).toEqual({ x: 1 });
    });
  });

  describe('validateOutput', () => {
    it('validates output files via the handle', async () => {
      await handle.writeJson('output', 'result.json', { ok: true });

      const result = await handle.validateOutput({
        files: [{ path: 'result.json', format: 'json', required: true }],
      });

      expect(result.valid).toBe(true);
    });

    it('reports missing required output files', async () => {
      const result = await handle.validateOutput({
        files: [{ path: 'missing.json', format: 'json', required: true }],
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Required file missing');
    });
  });
});
