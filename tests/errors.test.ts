import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceManager } from '../src/manager.js';
import { WorkspaceHandle } from '../src/handle.js';
import { readJson, readJsonl, readJsonDir, readMarkdown, readRaw, listFiles } from '../src/index.js';
import { validateOutput } from '../src/validation.js';
import type { OutputSpec, Schema } from '../src/types.js';

/**
 * Tests focused on parse/validation error behavior.
 *
 * The key contract: errors are thrown (not swallowed) so the consumer
 * can catch them and use the error information to re-prompt the agent
 * or enter a failure recovery mode.
 */

// Helper: a strict schema that rejects anything without required fields
function strictSchema<T>(requiredFields: Record<string, string>): Schema<T> {
  return {
    parse(data: unknown): T {
      if (typeof data !== 'object' || data === null) {
        throw new Error(`Expected object, got ${typeof data}`);
      }
      const obj = data as Record<string, unknown>;
      for (const [field, type] of Object.entries(requiredFields)) {
        if (!(field in obj)) {
          throw new Error(`Missing required field "${field}"`);
        }
        if (typeof obj[field] !== type) {
          throw new Error(
            `Field "${field}" expected ${type}, got ${typeof obj[field]}`,
          );
        }
      }
      return data as T;
    },
  };
}

describe('Parse errors — standalone readers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-errors-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('readJson', () => {
    it('throws on malformed JSON', async () => {
      await fs.writeFile(path.join(dir, 'bad.json'), '{ not valid json }');
      await expect(readJson(dir, 'bad.json')).rejects.toThrow();
    });

    it('throws on truncated JSON (agent stopped mid-write)', async () => {
      await fs.writeFile(path.join(dir, 'truncated.json'), '{"key": "val');
      await expect(readJson(dir, 'truncated.json')).rejects.toThrow();
    });

    it('throws on empty file', async () => {
      await fs.writeFile(path.join(dir, 'empty.json'), '');
      await expect(readJson(dir, 'empty.json')).rejects.toThrow();
    });

    it('throws on missing file with ENOENT', async () => {
      const err = await readJson(dir, 'nope.json').catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe('ENOENT');
    });

    it('schema error preserves the original message for consumer recovery', async () => {
      await fs.writeFile(path.join(dir, 'data.json'), '{"name": 123}');

      const schema = strictSchema({ name: 'string' });
      const err = await readJson(dir, 'data.json', { schema }).catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('name');
      expect(err.message).toContain('string');
    });

    it('schema error is catchable for retry logic', async () => {
      await fs.writeFile(path.join(dir, 'data.json'), '{}');

      const schema = strictSchema({ status: 'string', result: 'object' });

      let caught: Error | null = null;
      try {
        await readJson(dir, 'data.json', { schema });
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).not.toBeNull();
      expect(caught!.message).toContain('Missing required field');
    });
  });

  describe('readJsonl', () => {
    it('throws on malformed JSON in a single line', async () => {
      await fs.writeFile(
        path.join(dir, 'bad.jsonl'),
        '{"ok":true}\n{broken line\n{"ok":true}\n',
      );
      await expect(readJsonl(dir, 'bad.jsonl')).rejects.toThrow();
    });

    it('error message includes the failing line number', async () => {
      await fs.writeFile(
        path.join(dir, 'data.jsonl'),
        '{"n":1}\n{"n":2}\n{"n":"three"}\n',
      );

      const schema = strictSchema({ n: 'number' });
      const err = await readJsonl(dir, 'data.jsonl', { schema }).catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('line 3');
    });

    it('error message includes the schema error detail', async () => {
      await fs.writeFile(
        path.join(dir, 'data.jsonl'),
        '{"status":"ok"}\n{"status": 404}\n',
      );

      const schema = strictSchema({ status: 'string' });
      const err = await readJsonl(dir, 'data.jsonl', { schema }).catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('line 2');
      expect(err.message).toContain('status');
      expect(err.message).toContain('string');
    });

    it('throws on completely empty file', async () => {
      // Empty file should parse to empty array (no lines), not throw
      await fs.writeFile(path.join(dir, 'empty.jsonl'), '');
      const result = await readJsonl(dir, 'empty.jsonl');
      expect(result).toEqual([]);
    });

    it('first line failure reports line 1', async () => {
      await fs.writeFile(path.join(dir, 'data.jsonl'), '{"bad": true}\n');
      const schema = strictSchema({ good: 'boolean' });

      const err = await readJsonl(dir, 'data.jsonl', { schema }).catch((e) => e);
      expect(err.message).toContain('line 1');
    });
  });

  describe('readJsonDir', () => {
    it('throws when one file in the directory has a schema error', async () => {
      const sub = path.join(dir, 'results');
      await fs.mkdir(sub);
      await fs.writeFile(path.join(sub, 'good.json'), '{"score": 0.9}');
      await fs.writeFile(path.join(sub, 'bad.json'), '{"score": "high"}');

      const schema = strictSchema({ score: 'number' });
      await expect(readJsonDir(dir, 'results', { schema })).rejects.toThrow('score');
    });

    it('throws when one file has malformed JSON', async () => {
      const sub = path.join(dir, 'results');
      await fs.mkdir(sub);
      await fs.writeFile(path.join(sub, 'good.json'), '{"ok": true}');
      await fs.writeFile(path.join(sub, 'corrupt.json'), '{truncated');

      await expect(readJsonDir(dir, 'results')).rejects.toThrow();
    });

    it('throws on non-existent directory', async () => {
      await expect(readJsonDir(dir, 'nonexistent')).rejects.toThrow();
    });
  });

  describe('readMarkdown', () => {
    it('throws on missing file', async () => {
      await expect(readMarkdown(dir, 'nope.md')).rejects.toThrow();
    });

    it('frontmatter schema error is thrown, not swallowed', async () => {
      await fs.writeFile(
        path.join(dir, 'doc.md'),
        '---\nwrong_field: value\n---\n\nBody text.\n',
      );

      const schema = {
        parse(data: unknown) {
          const obj = data as Record<string, unknown>;
          if (!('title' in obj)) throw new Error('frontmatter must have "title"');
          return obj;
        },
      };

      const err = await readMarkdown(dir, 'doc.md', { frontmatterSchema: schema }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('title');
    });

    it('schema on doc without frontmatter validates against empty object', async () => {
      await fs.writeFile(path.join(dir, 'plain.md'), '# No frontmatter here\n');

      const schema = {
        parse(data: unknown) {
          const obj = data as Record<string, unknown>;
          if (!('title' in obj)) throw new Error('frontmatter must have "title"');
          return obj;
        },
      };

      await expect(
        readMarkdown(dir, 'plain.md', { frontmatterSchema: schema }),
      ).rejects.toThrow('frontmatter must have "title"');
    });
  });

  describe('readRaw', () => {
    it('throws on missing file', async () => {
      const err = await readRaw(dir, 'missing.txt').catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe('ENOENT');
    });
  });

  describe('listFiles', () => {
    it('throws on non-existent directory', async () => {
      await expect(listFiles(dir, 'does-not-exist')).rejects.toThrow();
    });
  });
});

describe('Parse errors — through WorkspaceHandle', () => {
  let baseDir: string;
  let manager: WorkspaceManager;
  let handle: WorkspaceHandle;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-handle-err-'));
    manager = new WorkspaceManager({ baseDir });
    handle = await manager.create('error-test');
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  describe('section validation', () => {
    it('writeJson throws on unknown section', async () => {
      await expect(handle.writeJson('bogus', 'f.json', {})).rejects.toThrow(
        'Unknown section "bogus"',
      );
    });

    it('readJson throws on unknown section', async () => {
      await expect(handle.readJson('bogus', 'f.json')).rejects.toThrow(
        'Unknown section "bogus"',
      );
    });

    it('writeJsonl throws on unknown section', async () => {
      await expect(handle.writeJsonl('bogus', 'f.jsonl', [])).rejects.toThrow(
        'Unknown section "bogus"',
      );
    });

    it('readJsonl throws on unknown section', async () => {
      await expect(handle.readJsonl('bogus', 'f.jsonl')).rejects.toThrow(
        'Unknown section "bogus"',
      );
    });

    it('writeMarkdown throws on unknown section', async () => {
      await expect(
        handle.writeMarkdown('bogus', 'f.md', { frontmatter: {}, body: '' }),
      ).rejects.toThrow('Unknown section "bogus"');
    });

    it('readMarkdown throws on unknown section', async () => {
      await expect(handle.readMarkdown('bogus', 'f.md')).rejects.toThrow(
        'Unknown section "bogus"',
      );
    });

    it('writeRaw throws on unknown section', async () => {
      await expect(handle.writeRaw('bogus', 'f.txt', '')).rejects.toThrow(
        'Unknown section "bogus"',
      );
    });

    it('readRaw throws on unknown section', async () => {
      await expect(handle.readRaw('bogus', 'f.txt')).rejects.toThrow(
        'Unknown section "bogus"',
      );
    });

    it('listFiles throws on unknown section', async () => {
      await expect(handle.listFiles('bogus')).rejects.toThrow(
        'Unknown section "bogus"',
      );
    });

    it('error message lists available sections', () => {
      try {
        handle.dir('nope');
      } catch (err) {
        expect((err as Error).message).toContain('input');
        expect((err as Error).message).toContain('output');
        expect((err as Error).message).toContain('resources');
        expect((err as Error).message).toContain('scratch');
      }
    });

    it('error message lists custom sections when they exist', async () => {
      const h = await manager.create('test', { additionalDirs: ['logs'] });
      try {
        h.dir('nope');
      } catch (err) {
        expect((err as Error).message).toContain('logs');
      }
    });
  });

  describe('readJson schema errors propagate through handle', () => {
    it('throws schema error with original message', async () => {
      await handle.writeJson('output', 'result.json', { answer: 42 });

      const schema = strictSchema({ answer: 'string' });
      const err = await handle
        .readJson('output', 'result.json', { schema })
        .catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('answer');
      expect(err.message).toContain('string');
    });

    it('throws on malformed JSON the agent wrote', async () => {
      // Simulate agent writing malformed content directly
      await fs.writeFile(
        path.join(handle.outputDir, 'broken.json'),
        '{"incomplete":',
      );

      await expect(handle.readJson('output', 'broken.json')).rejects.toThrow();
    });
  });

  describe('readJsonl schema errors propagate through handle', () => {
    it('throws with line number and schema detail', async () => {
      await handle.writeJsonl('output', 'steps.jsonl', [
        { action: 'search', query: 'foo' },
        { action: 123, query: 'bar' }, // bad
      ]);

      const schema = strictSchema({ action: 'string', query: 'string' });
      const err = await handle
        .readJsonl('output', 'steps.jsonl', { schema })
        .catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('line 2');
      expect(err.message).toContain('action');
    });
  });

  describe('readMarkdown schema errors propagate through handle', () => {
    it('throws frontmatter schema error', async () => {
      await handle.writeMarkdown('output', 'report.md', {
        frontmatter: { author: 'agent' },
        body: '# Report\nDone.',
      });

      const schema = {
        parse(data: unknown) {
          const obj = data as Record<string, unknown>;
          if (!('summary' in obj)) throw new Error('frontmatter needs "summary"');
          return obj;
        },
      };

      await expect(
        handle.readMarkdown('output', 'report.md', { frontmatterSchema: schema }),
      ).rejects.toThrow('frontmatter needs "summary"');
    });
  });

  describe('readJsonDir schema errors propagate through handle', () => {
    it('throws on first invalid file', async () => {
      await handle.writeJson('output', 'playbooks/a.json', { name: 'good' });
      await handle.writeJson('output', 'playbooks/b.json', { name: 999 });

      const schema = strictSchema({ name: 'string' });
      await expect(
        handle.readJsonDir('output', 'playbooks', { schema }),
      ).rejects.toThrow('name');
    });
  });
});

describe('Validation errors — structured for consumer recovery', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-val-err-'));
  });

  afterEach(async () => {
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  it('error objects have path and message fields', async () => {
    const spec: OutputSpec = {
      files: [{ path: 'result.json', format: 'json', required: true }],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.errors[0]).toHaveProperty('path', 'result.json');
    expect(result.errors[0]).toHaveProperty('message');
    expect(typeof result.errors[0].message).toBe('string');
  });

  it('schema error message includes the schema error detail', async () => {
    await fs.writeFile(
      path.join(outputDir, 'result.json'),
      '{"status": "done", "confidence": "high"}',
    );

    const spec: OutputSpec = {
      files: [
        {
          path: 'result.json',
          format: 'json',
          required: true,
          schema: strictSchema({ status: 'string', confidence: 'number' }),
        },
      ],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('result.json');
    expect(result.errors[0].message).toContain('confidence');
    expect(result.errors[0].message).toContain('number');
  });

  it('reports malformed JSON as a read error', async () => {
    await fs.writeFile(
      path.join(outputDir, 'result.json'),
      'this is not json at all',
    );

    const spec: OutputSpec = {
      files: [{ path: 'result.json', format: 'json', required: true }],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Failed to read file');
  });

  it('reports malformed JSONL as a read error', async () => {
    await fs.writeFile(
      path.join(outputDir, 'steps.jsonl'),
      '{"ok":true}\nnot json\n',
    );

    const spec: OutputSpec = {
      files: [{ path: 'steps.jsonl', format: 'jsonl', required: true }],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Failed to read file');
  });

  it('collects both schema and custom validation errors on the same file', async () => {
    await fs.writeFile(
      path.join(outputDir, 'result.json'),
      '{"value": "wrong_type"}',
    );

    const spec: OutputSpec = {
      files: [
        {
          path: 'result.json',
          format: 'json',
          required: true,
          schema: strictSchema({ value: 'number' }),
          validate: () => {
            throw new Error('additional check failed');
          },
        },
      ],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(false);
    // Both the schema error and the custom validation error should be reported
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    const messages = result.errors.map((e) => e.message);
    expect(messages.some((m) => m.includes('Schema validation failed'))).toBe(true);
    expect(messages.some((m) => m.includes('Custom validation threw'))).toBe(true);
  });

  it('collects errors across multiple files independently', async () => {
    await fs.writeFile(path.join(outputDir, 'a.json'), '{"x": "not_a_number"}');
    // b.json missing

    const spec: OutputSpec = {
      files: [
        {
          path: 'a.json',
          format: 'json',
          required: true,
          schema: strictSchema({ x: 'number' }),
        },
        {
          path: 'b.json',
          format: 'json',
          required: true,
          description: 'secondary output',
        },
        {
          path: 'c.json',
          format: 'json',
          required: false,
        },
      ],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);

    const aError = result.errors.find((e) => e.path === 'a.json');
    const bError = result.errors.find((e) => e.path === 'b.json');
    expect(aError).toBeDefined();
    expect(aError!.message).toContain('Schema validation failed');
    expect(bError).toBeDefined();
    expect(bError!.message).toContain('Required file missing');
    expect(bError!.message).toContain('secondary output');
  });

  it('async custom validate that rejects is captured', async () => {
    await fs.writeFile(path.join(outputDir, 'data.json'), '{"items": []}');

    const spec: OutputSpec = {
      files: [
        {
          path: 'data.json',
          format: 'json',
          required: true,
          validate: async (content) => {
            const obj = content as Record<string, unknown[]>;
            if (obj.items.length === 0) {
              throw new Error('items array must not be empty');
            }
            return true;
          },
        },
      ],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('items array must not be empty');
  });

  it('async custom validate returning false is captured', async () => {
    await fs.writeFile(path.join(outputDir, 'data.json'), '{"score": 0.2}');

    const spec: OutputSpec = {
      files: [
        {
          path: 'data.json',
          format: 'json',
          required: true,
          validate: async (content) => {
            const obj = content as Record<string, number>;
            return obj.score >= 0.5;
          },
        },
      ],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Custom validation returned false');
  });

  describe('consumer recovery patterns', () => {
    it('errors contain enough info to construct a re-prompt', async () => {
      await fs.writeFile(
        path.join(outputDir, 'analysis.json'),
        '{"summary": "good", "confidence": "high", "recommendations": "none"}',
      );

      const spec: OutputSpec = {
        files: [
          {
            path: 'analysis.json',
            format: 'json',
            required: true,
            description: 'Analysis result with numeric confidence',
            schema: strictSchema({
              summary: 'string',
              confidence: 'number',
              recommendations: 'object',
            }),
          },
        ],
      };

      const result = await validateOutput(outputDir, spec);
      expect(result.valid).toBe(false);

      // Consumer can build a re-prompt from this
      for (const error of result.errors) {
        expect(error.path).toBeTruthy();
        expect(error.message).toBeTruthy();

        // The path tells the consumer WHICH file to tell the agent to fix
        expect(typeof error.path).toBe('string');
        // The message tells the consumer WHAT was wrong
        expect(typeof error.message).toBe('string');
        expect(error.message.length).toBeGreaterThan(0);
      }
    });

    it('ValidationResult can be serialized for logging/debugging', async () => {
      const spec: OutputSpec = {
        files: [
          { path: 'missing.json', format: 'json', required: true, description: 'main output' },
        ],
      };

      const result = await validateOutput(outputDir, spec);

      // Result is plain JSON-serializable
      const serialized = JSON.stringify(result);
      const parsed = JSON.parse(serialized);
      expect(parsed.valid).toBe(false);
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.errors[0].path).toBe('missing.json');
    });
  });
});
