import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { writeJson, writeJsonl, writeMarkdown, writeRaw, copyDir, symlink } from '../src/index.js';

describe('Writers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-writers-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('writeJson', () => {
    it('writes pretty-printed JSON with trailing newline', async () => {
      await writeJson(dir, 'data.json', { foo: 'bar', num: 42 });
      const content = await fs.readFile(path.join(dir, 'data.json'), 'utf-8');
      expect(content).toBe('{\n  "foo": "bar",\n  "num": 42\n}\n');
    });

    it('creates subdirectories as needed', async () => {
      await writeJson(dir, 'nested/deep/data.json', { ok: true });
      const content = await fs.readFile(path.join(dir, 'nested/deep/data.json'), 'utf-8');
      expect(JSON.parse(content)).toEqual({ ok: true });
    });
  });

  describe('writeJsonl', () => {
    it('writes one JSON object per line', async () => {
      const items = [{ a: 1 }, { b: 2 }, { c: 3 }];
      await writeJsonl(dir, 'data.jsonl', items);
      const content = await fs.readFile(path.join(dir, 'data.jsonl'), 'utf-8');
      const lines = content.trimEnd().split('\n');
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0])).toEqual({ a: 1 });
      expect(JSON.parse(lines[2])).toEqual({ c: 3 });
    });
  });

  describe('writeMarkdown', () => {
    it('writes markdown with YAML frontmatter', async () => {
      await writeMarkdown(dir, 'doc.md', {
        frontmatter: { title: 'Hello', tags: ['a', 'b'] },
        body: '# Content\n\nSome text.',
      });
      const content = await fs.readFile(path.join(dir, 'doc.md'), 'utf-8');
      expect(content).toContain('---\n');
      expect(content).toContain('title: Hello');
      expect(content).toContain('# Content');
    });

    it('writes markdown without frontmatter when empty', async () => {
      await writeMarkdown(dir, 'plain.md', {
        frontmatter: {},
        body: '# Just body',
      });
      const content = await fs.readFile(path.join(dir, 'plain.md'), 'utf-8');
      expect(content).not.toContain('---');
      expect(content).toBe('# Just body\n');
    });
  });

  describe('writeRaw', () => {
    it('writes raw string content', async () => {
      await writeRaw(dir, 'data.csv', 'a,b,c\n1,2,3\n');
      const content = await fs.readFile(path.join(dir, 'data.csv'), 'utf-8');
      expect(content).toBe('a,b,c\n1,2,3\n');
    });
  });

  describe('copyDir', () => {
    it('copies a directory tree', async () => {
      // Create a source directory
      const src = path.join(dir, '_src');
      await fs.mkdir(path.join(src, 'sub'), { recursive: true });
      await fs.writeFile(path.join(src, 'a.txt'), 'hello');
      await fs.writeFile(path.join(src, 'sub', 'b.txt'), 'world');

      const dest = path.join(dir, 'dest');
      await fs.mkdir(dest, { recursive: true });
      await copyDir(dest, 'copied', src);

      const a = await fs.readFile(path.join(dest, 'copied', 'a.txt'), 'utf-8');
      const b = await fs.readFile(path.join(dest, 'copied', 'sub', 'b.txt'), 'utf-8');
      expect(a).toBe('hello');
      expect(b).toBe('world');
    });
  });

  describe('symlink', () => {
    it('creates a symlink to a target', async () => {
      const target = path.join(dir, 'target.txt');
      await fs.writeFile(target, 'symlinked');

      await symlink(dir, 'link.txt', target);

      const content = await fs.readFile(path.join(dir, 'link.txt'), 'utf-8');
      expect(content).toBe('symlinked');

      const stat = await fs.lstat(path.join(dir, 'link.txt'));
      expect(stat.isSymbolicLink()).toBe(true);
    });
  });
});
