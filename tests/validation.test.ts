import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { validateOutput } from '../src/validation.js';
import type { OutputSpec } from '../src/types.js';

describe('validateOutput', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-validation-'));
  });

  afterEach(async () => {
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  it('passes when all required files exist and are valid', async () => {
    await fs.writeFile(path.join(outputDir, 'result.json'), '{"ok": true}');

    const spec: OutputSpec = {
      files: [{ path: 'result.json', format: 'json', required: true }],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when a required file is missing', async () => {
    const spec: OutputSpec = {
      files: [
        {
          path: 'missing.json',
          format: 'json',
          required: true,
          description: 'The main result',
        },
      ],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('Required file missing');
    expect(result.errors[0].message).toContain('The main result');
  });

  it('skips missing optional files without error', async () => {
    const spec: OutputSpec = {
      files: [{ path: 'optional.json', format: 'json', required: false }],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates JSON files with a schema', async () => {
    await fs.writeFile(path.join(outputDir, 'result.json'), '{"count": "not a number"}');

    const spec: OutputSpec = {
      files: [
        {
          path: 'result.json',
          format: 'json',
          required: true,
          schema: {
            parse(data: unknown) {
              const obj = data as Record<string, unknown>;
              if (typeof obj.count !== 'number') throw new Error('count must be a number');
              return obj;
            },
          },
        },
      ],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Schema validation failed');
    expect(result.errors[0].message).toContain('count must be a number');
  });

  it('validates JSONL files with a schema (per-item)', async () => {
    await fs.writeFile(
      path.join(outputDir, 'steps.jsonl'),
      '{"step":1}\n{"step":"bad"}\n',
    );

    const spec: OutputSpec = {
      files: [
        {
          path: 'steps.jsonl',
          format: 'jsonl',
          required: true,
          schema: {
            parse(data: unknown) {
              const obj = data as Record<string, unknown>;
              if (typeof obj.step !== 'number') throw new Error('step must be number');
              return obj;
            },
          },
        },
      ],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Schema validation failed');
  });

  it('runs custom validate callback', async () => {
    await fs.writeFile(path.join(outputDir, 'result.json'), '{"score": 0.3}');

    const spec: OutputSpec = {
      files: [
        {
          path: 'result.json',
          format: 'json',
          required: true,
          validate: (content) => {
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

  it('catches errors thrown by custom validate callback', async () => {
    await fs.writeFile(path.join(outputDir, 'result.json'), '{"data": null}');

    const spec: OutputSpec = {
      files: [
        {
          path: 'result.json',
          format: 'json',
          required: true,
          validate: () => {
            throw new Error('Data cannot be null');
          },
        },
      ],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Custom validation threw');
    expect(result.errors[0].message).toContain('Data cannot be null');
  });

  it('validates markdown files', async () => {
    await fs.writeFile(
      path.join(outputDir, 'report.md'),
      '---\ntitle: Report\n---\n\n# Summary\n',
    );

    const spec: OutputSpec = {
      files: [{ path: 'report.md', format: 'markdown', required: true }],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(true);
  });

  it('validates raw files', async () => {
    await fs.writeFile(path.join(outputDir, 'output.txt'), 'some text');

    const spec: OutputSpec = {
      files: [{ path: 'output.txt', format: 'raw', required: true }],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(true);
  });

  it('collects multiple errors', async () => {
    const spec: OutputSpec = {
      files: [
        { path: 'a.json', format: 'json', required: true },
        { path: 'b.json', format: 'json', required: true },
        { path: 'c.json', format: 'json', required: false },
      ],
    };

    const result = await validateOutput(outputDir, spec);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2); // a.json and b.json missing, c.json optional
  });
});
