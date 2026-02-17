import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  readJson,
  readJsonl,
  readJsonDir,
  readMarkdown,
  readRaw,
  listFiles,
} from '../src/index.js';

describe('Readers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-readers-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('readJson', () => {
    it('reads and parses a JSON file', async () => {
      await fs.writeFile(path.join(dir, 'data.json'), '{"key": "value"}');
      const data = await readJson(dir, 'data.json');
      expect(data).toEqual({ key: 'value' });
    });

    it('validates with a schema', async () => {
      await fs.writeFile(path.join(dir, 'data.json'), '{"key": "value"}');

      const schema = {
        parse(data: unknown) {
          const obj = data as Record<string, string>;
          if (typeof obj.key !== 'string') throw new Error('key must be string');
          return obj;
        },
      };

      const data = await readJson(dir, 'data.json', { schema });
      expect(data).toEqual({ key: 'value' });
    });

    it('throws when schema validation fails', async () => {
      await fs.writeFile(path.join(dir, 'data.json'), '{"key": 123}');

      const schema = {
        parse(data: unknown) {
          const obj = data as Record<string, unknown>;
          if (typeof obj.key !== 'string') throw new Error('key must be string');
          return obj;
        },
      };

      await expect(readJson(dir, 'data.json', { schema })).rejects.toThrow('key must be string');
    });

    it('throws when file does not exist', async () => {
      await expect(readJson(dir, 'nonexistent.json')).rejects.toThrow();
    });
  });

  describe('readJsonl', () => {
    it('reads and parses a JSONL file', async () => {
      await fs.writeFile(path.join(dir, 'data.jsonl'), '{"a":1}\n{"b":2}\n{"c":3}\n');
      const items = await readJsonl(dir, 'data.jsonl');
      expect(items).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });

    it('validates each line with a schema', async () => {
      await fs.writeFile(path.join(dir, 'data.jsonl'), '{"n":1}\n{"n":2}\n');

      const schema = {
        parse(data: unknown) {
          const obj = data as Record<string, number>;
          if (typeof obj.n !== 'number') throw new Error('n must be number');
          return obj;
        },
      };

      const items = await readJsonl(dir, 'data.jsonl', { schema });
      expect(items).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it('throws with line number on validation failure', async () => {
      await fs.writeFile(path.join(dir, 'data.jsonl'), '{"n":1}\n{"n":"bad"}\n');

      const schema = {
        parse(data: unknown) {
          const obj = data as Record<string, unknown>;
          if (typeof obj.n !== 'number') throw new Error('n must be number');
          return obj;
        },
      };

      await expect(readJsonl(dir, 'data.jsonl', { schema })).rejects.toThrow(
        'JSONL validation failed at line 2',
      );
    });
  });

  describe('readJsonDir', () => {
    it('reads all JSON files in a directory', async () => {
      const sub = path.join(dir, 'results');
      await fs.mkdir(sub);
      await fs.writeFile(path.join(sub, 'a.json'), '{"x":1}');
      await fs.writeFile(path.join(sub, 'b.json'), '{"x":2}');
      await fs.writeFile(path.join(sub, 'c.txt'), 'not json'); // should be skipped

      const result = await readJsonDir(dir, 'results');
      expect(result.size).toBe(2);
      expect(result.get('a.json')).toEqual({ x: 1 });
      expect(result.get('b.json')).toEqual({ x: 2 });
    });
  });

  describe('readMarkdown', () => {
    it('reads markdown with YAML frontmatter', async () => {
      await fs.writeFile(
        path.join(dir, 'doc.md'),
        '---\ntitle: Hello\ntags:\n  - a\n  - b\n---\n\n# Content\n',
      );

      const doc = await readMarkdown(dir, 'doc.md');
      expect(doc.frontmatter).toEqual({ title: 'Hello', tags: ['a', 'b'] });
      expect(doc.body).toBe('# Content\n');
    });

    it('reads markdown without frontmatter', async () => {
      await fs.writeFile(path.join(dir, 'plain.md'), '# No frontmatter\n');

      const doc = await readMarkdown(dir, 'plain.md');
      expect(doc.frontmatter).toEqual({});
      expect(doc.body).toBe('# No frontmatter\n');
    });

    it('validates frontmatter with a schema', async () => {
      await fs.writeFile(
        path.join(dir, 'doc.md'),
        '---\ntitle: Test\n---\n\nBody.\n',
      );

      const schema = {
        parse(data: unknown) {
          const obj = data as Record<string, string>;
          if (!obj.title) throw new Error('title required');
          return obj;
        },
      };

      const doc = await readMarkdown(dir, 'doc.md', { frontmatterSchema: schema });
      expect(doc.frontmatter).toEqual({ title: 'Test' });
    });

    it('throws when frontmatter schema fails', async () => {
      await fs.writeFile(
        path.join(dir, 'doc.md'),
        '---\nfoo: bar\n---\n\nBody.\n',
      );

      const schema = {
        parse(data: unknown) {
          const obj = data as Record<string, string>;
          if (!obj.title) throw new Error('title required');
          return obj;
        },
      };

      await expect(readMarkdown(dir, 'doc.md', { frontmatterSchema: schema })).rejects.toThrow(
        'title required',
      );
    });
  });

  describe('readRaw', () => {
    it('reads a file as a raw string', async () => {
      await fs.writeFile(path.join(dir, 'data.txt'), 'hello world');
      const content = await readRaw(dir, 'data.txt');
      expect(content).toBe('hello world');
    });
  });

  describe('listFiles', () => {
    it('lists files recursively', async () => {
      await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
      await fs.writeFile(path.join(dir, 'a.txt'), '');
      await fs.writeFile(path.join(dir, 'sub', 'b.txt'), '');

      const files = await listFiles(dir);
      expect(files.sort()).toEqual(['a.txt', 'sub/b.txt'].sort());
    });

    it('lists files under a subpath', async () => {
      const sub = path.join(dir, 'nested');
      await fs.mkdir(sub);
      await fs.writeFile(path.join(sub, 'file.txt'), '');

      const files = await listFiles(dir, 'nested');
      expect(files).toEqual(['nested/file.txt']);
    });
  });
});
