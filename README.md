<div align="center">
    <picture>
        <img alt="agent-workspace banner" src="https://raw.githubusercontent.com/alexngai/agent-workspace/main/media/banner.png">
    </picture>
</div>

# agent-workspace

[![npm version](https://img.shields.io/npm/v/agent-workspace.svg?style=flat)](https://www.npmjs.com/package/agent-workspace)
[![license](https://img.shields.io/npm/l/agent-workspace.svg?style=flat)](https://github.com/alexngai/agent-workspace/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/agent-workspace.svg?style=flat)](https://nodejs.org)

TypeScript library for managing filesystem workspaces used by AI agents. Provides structured directory layouts, typed readers and writers for JSON, JSONL, Markdown with YAML frontmatter, and raw text, plus output validation that collects all errors instead of throwing on the first failure.

---

## The problem

AI agents write intermediate results, final outputs, and scratch data to disk. Without structure, this becomes ad hoc file paths scattered across functions, inconsistent error handling across formats, and no reliable way to check what an agent actually produced before the calling code reads it.

`agent-workspace` gives each agent run a dedicated directory with a predictable layout, typed I/O, and a validation pass that reports all output problems at once. Error messages are written for agent re-prompting: each error identifies the file and describes the issue in plain terms.

---

## Table of contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Workspace layout](#workspace-layout)
- [WorkspaceManager](#workspacemanager)
- [WorkspaceHandle](#workspacehandle)
- [Formats](#formats)
- [Output validation](#output-validation)
- [Error handling](#error-handling)
- [Standalone functions](#standalone-functions)
- [Schema interface](#schema-interface)
- [TypeScript support](#typescript-support)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Prerequisites

- Node.js >= 18
- npm, yarn, or pnpm

---

## Installation

```bash
npm install agent-workspace
```

The only runtime dependency is `yaml`, used for YAML frontmatter in Markdown files. All other functionality relies on Node.js built-ins.

---

## Quick start

```typescript
import { WorkspaceManager } from 'agent-workspace';

const manager = new WorkspaceManager();

// Create a workspace for a summarization run
const ws = await manager.create('summarize-docs');

// Write inputs for the agent
await ws.writeJson('input', 'config.json', {
  model: 'claude-sonnet',
  maxSteps: 10,
  sources: ['q1-report.pdf', 'q2-report.pdf'],
});
await ws.writeRaw('resources', 'system-prompt.txt', 'You are a research assistant...');

// Agent writes outputs
await ws.writeJson('output', 'result.json', { summary: '...', confidence: 0.92 });
await ws.writeMarkdown('output', 'report.md', {
  frontmatter: { title: 'Q1-Q2 Summary', date: '2025-01-15' },
  body: '# Findings\n\nRevenue grew 18% YoY...',
});

// Validate what the agent produced before reading
const validation = await ws.validateOutput({
  files: [
    { path: 'result.json', format: 'json', required: true, description: 'Structured result' },
    { path: 'report.md', format: 'markdown', required: true, description: 'Human-readable report' },
  ],
});

if (!validation.valid) {
  // Each error has { path, message } — enough to re-prompt the agent
  for (const err of validation.errors) {
    console.error(`${err.path}: ${err.message}`);
  }
} else {
  console.log('Output valid. Workspace:', ws.id);
  // => Output valid. Workspace: summarize-docs-1718300000000-a3f2b1c4
}

// Clean up when done
await manager.cleanup(ws);
```

To verify it worked: `validation.valid` is `true` and no errors are logged.

---

## Workspace layout

Every workspace gets four directories by default:

```
<baseDir>/agent-workspaces/<taskType>-<timestamp>-<uuid>/
  input/           # configuration, prompts, data the agent reads
  output/          # results the agent produces
  resources/       # reference material, shared assets
  scratch/         # intermediate work, logs, debug output
  .workspace.json  # metadata: { id, taskType, createdAt, dirs }
```

You can add custom directories at creation time:

```typescript
const ws = await manager.create('pipeline', {
  additionalDirs: ['logs', 'cache'],
});

ws.dir('logs');   // => /tmp/agent-workspaces/pipeline-.../logs
ws.dir('cache');  // => /tmp/agent-workspaces/pipeline-.../cache
```

The `.workspace.json` file lets the manager reconstruct handles when you call `list()`.

---

## WorkspaceManager

`WorkspaceManager` controls the lifecycle of workspaces on disk.

```typescript
import { WorkspaceManager } from 'agent-workspace';

const manager = new WorkspaceManager({
  baseDir: '/var/agent-runs',  // default: os.tmpdir()
  prefix: 'my-agent',         // default: 'agent-workspaces'
});
// workspaces created under: /var/agent-runs/my-agent/<id>
```

### `create(taskType, options?)`

Creates a new workspace and returns a `WorkspaceHandle`.

```typescript
const ws = await manager.create('extract-entities', {
  additionalDirs: ['entities'],
});
// ws.id   => 'extract-entities-1718300000000-a3f2b1c4'
// ws.path => '/var/agent-runs/my-agent/extract-entities-1718300000000-a3f2b1c4'
```

### `list()`

Returns handles for all workspaces under the managed root. Directories without valid `.workspace.json` files are silently skipped.

```typescript
const all = await manager.list();
console.log(all.map(w => w.id));
// => ['summarize-docs-1718200000000-...', 'extract-entities-1718300000000-...']
```

### `cleanup(handle)`

Removes a workspace directory from disk.

```typescript
await manager.cleanup(ws);
```

### `pruneStale(maxAgeMs)`

Removes all workspaces older than `maxAgeMs` milliseconds. Returns the number of workspaces deleted.

```typescript
// Remove workspaces older than 24 hours
const pruned = await manager.pruneStale(24 * 60 * 60 * 1000);
console.log(`Pruned ${pruned} stale workspaces`);
```

---

## WorkspaceHandle

`WorkspaceHandle` is the I/O facade for a single workspace. Every read and write method takes a section name as its first argument.

### Properties

| Property | Type | Description |
|---|---|---|
| `id` | `string` | Unique workspace ID (`taskType-timestamp-uuid`) |
| `path` | `string` | Absolute path to the workspace root |
| `createdAt` | `Date` | When the workspace was created |
| `inputDir` | `string` | Absolute path to `input/` |
| `outputDir` | `string` | Absolute path to `output/` |
| `resourcesDir` | `string` | Absolute path to `resources/` |
| `scratchDir` | `string` | Absolute path to `scratch/` |

### `dir(section)`

Returns the absolute path to a section directory. Throws synchronously if the section does not exist in the workspace.

```typescript
ws.dir('output');      // => '/var/agent-runs/.../output'
ws.dir('nonexistent'); // throws: 'Unknown section "nonexistent". Available: input, output, ...'
```

---

## Formats

### JSON

```typescript
// Write (pretty-printed, trailing newline)
await ws.writeJson('output', 'result.json', {
  entities: [{ name: 'Acme Corp', type: 'ORG' }],
  extractedAt: new Date().toISOString(),
});

// Read without schema — returns unknown
const raw = await ws.readJson('output', 'result.json');

// Read with schema validation (Zod)
import { z } from 'zod';

const ResultSchema = z.object({
  entities: z.array(z.object({ name: z.string(), type: z.string() })),
  extractedAt: z.string(),
});

const result = await ws.readJson('output', 'result.json', { schema: ResultSchema });
// result.entities[0].name => 'Acme Corp'
```

### JSONL

Each line is a separate JSON object. Useful for streaming records or step logs.

```typescript
await ws.writeJsonl('scratch', 'steps.jsonl', [
  { step: 1, action: 'search', query: 'quantum computing fundamentals' },
  { step: 2, action: 'summarize', source: 'arxiv:2401.1234', tokens: 1842 },
  { step: 3, action: 'cite', count: 3 },
]);

const steps = await ws.readJsonl('scratch', 'steps.jsonl');
// => [{ step: 1, ... }, { step: 2, ... }, { step: 3, ... }]
```

Schema validation on JSONL applies per line. Errors include the line number:

```
JSONL validation failed at line 2: Expected number, received string at "step"
```

### Markdown with YAML frontmatter

```typescript
// Write
await ws.writeMarkdown('output', 'report.md', {
  frontmatter: {
    title: 'Competitive Analysis',
    status: 'draft',
    confidence: 0.87,
  },
  body: '## Summary\n\nThree competitors identified in the APAC region.',
});

// Read — frontmatter typed as Record<string, unknown> by default
const doc = await ws.readMarkdown('output', 'report.md');
doc.frontmatter.title;  // => 'Competitive Analysis'
doc.body;               // => '## Summary\n\nThree competitors...'
```

Files without a `---` frontmatter block return `frontmatter: {}` and the full content as `body`.

You can validate frontmatter with a schema:

```typescript
const FrontmatterSchema = z.object({
  title: z.string(),
  confidence: z.number(),
});

const doc = await ws.readMarkdown('output', 'report.md', {
  frontmatterSchema: FrontmatterSchema,
});
// doc.frontmatter is typed as { title: string; confidence: number }
```

### Raw text

```typescript
await ws.writeRaw('scratch', 'debug.log', 'Token count: 4096\nLatency: 1.2s\n');
const log = await ws.readRaw('scratch', 'debug.log');
```

### Directory operations

```typescript
// List all files in a section (recursive, returns relative paths)
const files = await ws.listFiles('output');
// => ['report.md', 'result.json', 'charts/bar.svg']

// List files within a subdirectory
const charts = await ws.listFiles('output', 'charts');
// => ['bar.svg']

// Read all .json files in a subdirectory into a Map<filename, parsed>
const byDoc = await ws.readJsonDir('output', 'per-doc');
byDoc.get('doc1.json'); // => { ... }

// Copy an external directory into a section
await ws.copyDir('resources', 'reference-data', '/data/industry-codes');

// Create a symlink inside a section pointing to an external path
await ws.symlink('resources', 'model-weights', '/opt/ml/models/v3');
```

---

## Output validation

`validateOutput` checks a workspace's output directory against a specification. It never throws. All errors are collected and returned in `{ valid, errors }`.

```typescript
import { z } from 'zod';

const SummarySchema = z.object({
  title: z.string(),
  confidence: z.number().min(0).max(1),
});

const result = await ws.validateOutput({
  files: [
    {
      path: 'result.json',
      format: 'json',
      required: true,
      description: 'Structured result with confidence score',
      schema: SummarySchema,
    },
    {
      path: 'report.md',
      format: 'markdown',
      required: true,
      description: 'Human-readable report',
    },
    {
      path: 'steps.jsonl',
      format: 'jsonl',
      required: false,
      validate: (items) => {
        // Custom check: at least one step recorded
        return (items as unknown[]).length > 0;
      },
    },
  ],
});

if (!result.valid) {
  for (const err of result.errors) {
    console.log(`${err.path}: ${err.message}`);
  }
}
```

Example error messages:

```
result.json: Required file missing (Structured result with confidence score)
report.md: Schema validation failed: Expected string, received number at 'title'
steps.jsonl: Custom validation returned false
steps.jsonl: Custom validation threw: length must be greater than 0
```

**Collection rules:**

- Missing required files add an error and skip further checks for that file.
- Missing optional files are silently skipped.
- Schema and custom `validate` run independently; both can report errors for the same file.
- `validate` can return `false` or throw; both produce an error entry.
- `validateOutput` never throws under any circumstances.

---

## Error handling

Readers and `validateOutput` use two distinct error strategies.

**Readers throw** on any error: missing file, malformed content, schema failure. Use try/catch for recovery or retry logic.

```typescript
try {
  const data = await ws.readJson('output', 'result.json', { schema: ResultSchema });
} catch (err) {
  // err.message has enough detail to diagnose the problem
  // ENOENT errors include the file path
  // Schema errors include the schema library's message
}
```

**`validateOutput` collects** errors without throwing. Use it to check all output files before reading any of them.

```typescript
const { valid, errors } = await ws.validateOutput(spec);
if (!valid) {
  const feedback = errors.map(e => `- ${e.path}: ${e.message}`).join('\n');
  // Pass feedback to the agent for re-prompting
}
```

---

## Standalone functions

All readers and writers are exported as standalone functions. They take an absolute directory path as their first argument instead of a section name.

```typescript
import {
  readJson, readJsonl, readJsonDir,
  readMarkdown, readRaw, listFiles,
  writeJson, writeJsonl,
  writeMarkdown,
  writeRaw, copyDir, symlink,
  validateOutput,
} from 'agent-workspace';

const config = await readJson('/data/runs/run-42/input', 'config.json');
await writeJsonl('/data/runs/run-42/output', 'records.jsonl', records);

const result = await validateOutput('/data/runs/run-42/output', { files: [...] });
```

Writers automatically create parent directories. You do not need to `mkdir` first.

---

## Schema interface

The library uses a minimal interface so it works with any validation library:

```typescript
interface Schema<T> {
  parse(data: unknown): T; // must throw on invalid data
}
```

**Zod** satisfies this interface directly:

```typescript
import { z } from 'zod';

const schema = z.object({ confidence: z.number().min(0).max(1) });
const data = await ws.readJson('output', 'result.json', { schema });
// data is typed as { confidence: number }
```

**Joi** returns a result object instead of throwing by default. Wrap it:

```typescript
import Joi from 'joi';

const joiSchema = Joi.object({ confidence: Joi.number().required() });

const schema = {
  parse(data: unknown) {
    const { error, value } = joiSchema.validate(data);
    if (error) throw error;
    return value;
  },
};
```

Any object with a `parse` method that throws on failure works the same way.

---

## TypeScript support

The package ships TypeScript declarations for all exports. Both ESM and CJS builds are included via `exports` conditions.

```typescript
import type {
  Schema,
  WorkspaceMeta,
  WorkspaceManagerConfig,
  CreateWorkspaceOptions,
  MarkdownDocument,
  OutputSpec,
  OutputFileSpec,
  ValidationResult,
  ValidationError,
  ReadJsonOptions,
  ReadMarkdownOptions,
} from 'agent-workspace';
```

The library targets ES2022, uses TypeScript strict mode, and ships `"type": "module"` with dual CJS/ESM output via `tsup`. It works in ESM and CommonJS projects without configuration changes.

---

## Limitations

**Node.js only.** The library uses `fs`, `path`, `os`, and `crypto` from Node.js. It does not run in browsers, Deno, Bun, or edge runtimes.

**Local filesystem only.** Workspaces live on disk. There is no S3, GCS, or remote storage backend.

**No concurrency control.** Two processes writing to the same workspace section simultaneously will produce undefined results. Coordinate parallel writes at the application level.

**No file watching.** The library does not emit events when files change. Poll `list()` or `listFiles()` to detect changes.

**Schema libraries that return result objects need a wrapper.** The `parse` method must throw on invalid data. Libraries like Joi require a thin wrapper (see [Schema interface](#schema-interface)).

**Pruning is time-based only.** `pruneStale` compares `createdAt` from `.workspace.json` against a maximum age. There is no size-based or access-based pruning.

---

## Troubleshooting

**`Unknown section "X". Available: input, output, ...`**

You passed a section name that was not created with the workspace. Either use one of the four default sections (`input`, `output`, `resources`, `scratch`) or declare the section at creation time:

```typescript
const ws = await manager.create('my-task', {
  additionalDirs: ['X'],
});
```

**`JSONL validation failed at line N: ...`**

One line in the JSONL file failed schema validation. The error includes the 1-based line number. Open the file and check line N for malformed or unexpected data.

**`validateOutput` reports `Required file missing` but the file exists**

The `path` in `OutputFileSpec` is relative to the output directory, not the workspace root. Use `result.json`, not `output/result.json`.

**Writers silently overwrite existing files**

`writeJson`, `writeJsonl`, `writeMarkdown`, and `writeRaw` do not check for existing content before writing. Call `listFiles()` first if you need to guard against overwrites.

**`pruneStale` removes nothing even though workspaces are old**

`pruneStale` reads `createdAt` from each workspace's `.workspace.json`. If that file is missing or corrupt, `list()` skips the directory entirely and `pruneStale` never considers it. Remove such directories manually.

---

## Contributing

```bash
git clone https://github.com/alexngai/agent-workspace.git
cd agent-workspace
npm install
npm test          # 101 tests across 6 files
npm test -- readers.test.ts  # run a single test file
npm run typecheck # type-check without emitting
```

Tests use temporary directories under `os.tmpdir()` and clean up in `afterEach`. When adding functionality:

- Add happy-path tests to the relevant existing file (`readers.test.ts`, `writers.test.ts`, `handle.test.ts`, `manager.test.ts`, or `validation.test.ts`).
- Add error and throw behavior tests to `errors.test.ts`.
- All reader error paths require tests: missing file, malformed content, schema rejection.
- Validation tests must verify that errors are collected, not thrown, and that each error includes both `path` and `message`.

---

## License

MIT
