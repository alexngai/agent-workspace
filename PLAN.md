# Plan: `agent-workspace` npm package

## What this package is

A standalone TypeScript library for creating, populating, validating, and cleaning up filesystem workspaces that agents (or any process) can work in. It handles the directory structure, file I/O in common formats, output validation, and lifecycle management.

The package is **agent-agnostic** — it doesn't know how agents are spawned, what framework they use, or what domain they operate in. The consumer decides all of that.

## What this package is NOT

- Not an agent runner/orchestrator
- Not a task template system (the consumer defines what goes in/out)
- Not coupled to any memory system, learning pipeline, or specific agent framework
- Not opinionated about what agent reads/writes — just provides structure and utilities

## Core API Surface

### 1. `WorkspaceManager`

Factory that creates and manages workspaces. Holds configuration like the base directory for workspace storage.

```typescript
const manager = new WorkspaceManager({ baseDir: '/tmp' });
const workspace = await manager.create('my-task-type');
// workspace.path → /tmp/agent-workspaces/my-task-type-1708000000-abc123/
```

**Configuration:**
- `baseDir` — where workspaces are created (default: `os.tmpdir()`)
- `prefix` — namespace for the workspaces directory (default: `'agent-workspaces'`)

**Lifecycle methods:**
- `create(taskType: string, options?)` → `WorkspaceHandle`
- `cleanup(handle)` — remove a workspace
- `list()` — list active workspaces
- `pruneStale(maxAgeMs)` — remove old workspaces

### 2. `WorkspaceHandle`

Represents a created workspace. Provides paths and I/O methods.

```typescript
interface WorkspaceHandle {
  id: string;
  path: string;           // root
  inputDir: string;       // {root}/input/
  outputDir: string;      // {root}/output/
  resourcesDir: string;   // {root}/resources/
  scratchDir: string;     // {root}/scratch/   (agent working space)
  createdAt: Date;
}
```

### 3. Directory Structure

Default layout (configurable):

```
{workspace}/
├── input/          # Prepared input data for the agent
├── output/         # Where the agent writes results
├── resources/      # Supplementary reference material
└── scratch/        # Agent scratch space (notes, temp files)
```

**Open question: Should additional directories be configurable?**

The design doc has `skills/` as a first-class directory. Two options:

- **Option A**: Fixed set of directories (input, output, resources, scratch) — consumers put skills in `resources/skills/` or wherever they want.
- **Option B**: Configurable directory list — consumer can declare extra top-level directories at creation time.
- **Option C**: The four defaults exist, plus `create()` accepts `additionalDirs: string[]` for extras.

Leaning toward **Option A** for simplicity. `skills/` is domain-specific to the cognitive-core use case. A generic package shouldn't bake it in. Consumers can mkdir inside `resources/` or `input/` as needed.

### 4. File I/O — Writers

Methods on `WorkspaceHandle` (or standalone functions taking a handle) for writing common formats:

```typescript
// JSON — pretty-printed, one file
await workspace.writeJson('input', 'config.json', { key: 'value' });

// JSONL — array of items, one per line
await workspace.writeJsonl('input', 'trajectories/steps.jsonl', items);

// Markdown with YAML frontmatter
await workspace.writeMarkdown('input', 'context.md', {
  frontmatter: { taskId: '123', domain: 'analysis' },
  body: '# Task\n\nDo the thing.'
});

// Raw file (any string content)
await workspace.writeRaw('input', 'data.csv', csvContent);

// Copy a directory tree into resources
await workspace.copyDir('resources', 'codebase', '/path/to/repo');

// Symlink into resources
await workspace.symlink('resources', 'codebase', '/path/to/repo');
```

The first argument is which section (input/output/resources/scratch) — this avoids accidentally writing to the wrong place and keeps the API explicit. Subdirectories are created automatically.

### 5. File I/O — Readers

```typescript
// JSON — parse and optionally validate
const data = await workspace.readJson('output', 'result.json');
const validated = await workspace.readJson('output', 'result.json', { schema: myZodSchema });

// JSONL — returns array
const items = await workspace.readJsonl('output', 'steps.jsonl');

// Markdown — returns { frontmatter, body } or raw string
const doc = await workspace.readMarkdown('output', 'report.md');

// Raw
const raw = await workspace.readRaw('output', 'data.txt');

// List files in a section/subdirectory
const files = await workspace.listFiles('output', 'playbooks/');

// Read all JSON files in a subdirectory as a Map
const allResults = await workspace.readJsonDir('output', 'playbooks/');
```

### 6. Output Validation

Consumer defines expected outputs, the workspace validates them:

```typescript
interface OutputSpec {
  files: OutputFileSpec[];
}

interface OutputFileSpec {
  path: string;                          // relative to output/
  format: 'json' | 'jsonl' | 'markdown' | 'raw';
  required: boolean;
  description?: string;                  // for error messages
  validate?: (content: unknown) => boolean | Promise<boolean>;  // custom validator
  schema?: ZodSchema;                    // Zod schema for JSON validation
}
```

Usage:

```typescript
const spec: OutputSpec = {
  files: [
    { path: 'result.json', format: 'json', required: true, schema: ResultSchema },
    { path: 'report.md', format: 'markdown', required: false },
  ]
};

const result = await workspace.validateOutput(spec);
// { valid: boolean, errors: ValidationError[] }
// errors include: missing required files, schema validation failures, custom validator failures
```

**Key question**: Should validation be a method on the handle, or a separate function?

Leaning toward method on handle for ergonomics, but also exporting a standalone `validateOutput(outputDir, spec)` function for consumers who build their own workspace structure.

### 7. Schema Validation

The package should support Zod schemas but NOT depend on Zod directly. Options:

- **Option A**: Peer dependency on Zod — consumer must install Zod.
- **Option B**: Accept any `{ parse(data: unknown): T }` interface — works with Zod, Joi, custom parsers.
- **Option C**: No schema integration — just provide the `validate` callback and let consumers use whatever.

Leaning toward **Option B** — define a minimal `Schema<T>` interface that Zod satisfies naturally:

```typescript
interface Schema<T = unknown> {
  parse(data: unknown): T;  // throws on invalid
}
```

This way Zod schemas work out of the box without Zod being a dependency.

### 8. YAML Frontmatter

The markdown writer needs to serialize frontmatter. Options:

- **Option A**: Bundle a small YAML serializer (just handle scalars, arrays, simple objects).
- **Option B**: Depend on `yaml` npm package.
- **Option C**: Use JSON in the frontmatter block (valid YAML subset).

Leaning toward **Option A** for the writer (simple cases only) and **Option B** (`yaml` package) for the reader (parsing arbitrary frontmatter). Or just depend on `yaml` for both — it's small and well-maintained.

## Package Structure

```
agent-workspace/
├── src/
│   ├── index.ts                 # Public API exports
│   ├── manager.ts               # WorkspaceManager class
│   ├── handle.ts                # WorkspaceHandle class
│   ├── writers/
│   │   ├── json.ts              # JSON and JSONL writers
│   │   ├── markdown.ts          # Markdown + frontmatter writer
│   │   └── raw.ts               # Raw file + copy/symlink
│   ├── readers/
│   │   ├── json.ts              # JSON and JSONL readers
│   │   ├── markdown.ts          # Markdown + frontmatter parser
│   │   └── raw.ts               # Raw file reader
│   ├── validation.ts            # Output validation
│   └── types.ts                 # All type definitions
├── tests/
│   ├── manager.test.ts
│   ├── writers.test.ts
│   ├── readers.test.ts
│   └── validation.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

## Dependencies

- `yaml` — YAML parsing for frontmatter (small, well-maintained)
- No other runtime dependencies

Dev dependencies: `typescript`, `vitest` (or `jest`), `tsup` (bundler), `@types/node`.

## Build / Publish

- TypeScript compiled to ESM + CJS (dual package via tsup)
- Exports types via `exports` field in package.json
- Node.js >= 18 (uses `fs/promises`, `crypto.randomUUID`)

## Implementation Order

1. **Types** — all interfaces and type definitions
2. **WorkspaceManager** — create, cleanup, list, pruneStale
3. **Writers** — JSON, JSONL, markdown, raw, copy, symlink
4. **Readers** — JSON, JSONL, markdown, raw, listFiles, readJsonDir
5. **WorkspaceHandle** — wire writers/readers as methods on the handle
6. **Validation** — output spec validation with schema support
7. **Tests** — for each module
8. **Package config** — package.json, tsconfig, build setup

## Open Questions for Discussion

1. **Directory structure**: Fixed 4 dirs (input/output/resources/scratch) vs configurable?
2. **Schema integration**: Minimal `{ parse }` interface vs Zod peer dep vs callbacks only?
3. **YAML**: Bundle simple serializer or depend on `yaml` package?
4. **Handle API style**: Methods on handle (`workspace.writeJson(...)`) vs standalone functions (`writeJson(workspace, ...)`)?
5. **Section parameter**: String literal union `'input' | 'output' | 'resources' | 'scratch'` or free-form string?
6. **Naming**: `scratch` vs `workspace` for the agent working directory? (The design doc uses `workspace/` but that's confusing when the whole thing is called a workspace.)
7. **Error handling**: Return `null` on missing files (like the design doc) or throw? Or both via options?
