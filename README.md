<div align="center">
    <picture>
        <img alt="agent-workspace banner" src="https://raw.githubusercontent.com/alexngai/agent-workspace/main/media/banner.png">
    </picture>
</div>

# agent-workspace

Filesystem workspace management for AI agents. Provides directory structure, typed I/O (JSON, JSONL, Markdown, raw text), and output validation with structured error reporting.

## Install

```bash
npm install agent-workspace
```

Requires Node.js >= 18.

## Quick start

```ts
import { WorkspaceManager } from 'agent-workspace';

// 1. Create a workspace
const manager = new WorkspaceManager({ baseDir: '/tmp' });
const ws = await manager.create('research');

// 2. Write inputs for the agent
await ws.writeJson('input', 'config.json', { model: 'claude-sonnet', maxSteps: 10 });
await ws.writeRaw('resources', 'system-prompt.txt', 'You are a research assistant...');

// 3. Agent writes outputs
await ws.writeJson('output', 'result.json', { summary: '...', confidence: 0.92 });
await ws.writeJsonl('output', 'steps.jsonl', [
  { action: 'search', query: 'quantum computing' },
  { action: 'summarize', source: 'arxiv:2401.1234' },
]);
await ws.writeMarkdown('output', 'report.md', {
  frontmatter: { title: 'Research Report', date: '2025-01-15' },
  body: '# Findings\n\nQuantum computing is...',
});

// 4. Validate outputs
const result = await ws.validateOutput({
  files: [
    { path: 'result.json', format: 'json', required: true, schema: mySchema },
    { path: 'report.md', format: 'markdown', required: true },
    { path: 'steps.jsonl', format: 'jsonl', required: false },
  ],
});

if (!result.valid) {
  // Each error has { path, message } — enough to re-prompt the agent
  console.error(result.errors);
}

// 5. Cleanup
await manager.cleanup(ws);
```

## Concepts

### Workspace structure

Every workspace gets four default directories:

```
<workspace>/
  input/       ← configuration, prompts, data the agent reads
  output/      ← results the agent produces
  resources/   ← reference material, shared assets
  scratch/     ← temporary/intermediate files
  .workspace.json  ← metadata (id, taskType, createdAt, dirs)
```

You can add custom directories at creation time:

```ts
const ws = await manager.create('pipeline', { additionalDirs: ['logs', 'cache'] });
ws.dir('logs');  // /tmp/agent-workspaces/<id>/logs
```

### WorkspaceManager

Manages workspace lifecycle.

```ts
const manager = new WorkspaceManager({
  baseDir: '/tmp',             // default: os.tmpdir()
  prefix: 'agent-workspaces', // default: 'agent-workspaces'
});

const ws = await manager.create('my-task');       // create
const all = await manager.list();                 // list all
await manager.cleanup(ws);                        // delete one
const pruned = await manager.pruneStale(3600000); // delete workspaces older than 1 hour
```

### WorkspaceHandle

Returned by `manager.create()`. All I/O is scoped by section name.

```ts
// Section-scoped I/O — first argument is always the section
await ws.writeJson('output', 'data.json', { key: 'value' });
const data = await ws.readJson('output', 'data.json');

// Convenience accessors for default sections
ws.inputDir;     // absolute path to input/
ws.outputDir;    // absolute path to output/
ws.resourcesDir; // absolute path to resources/
ws.scratchDir;   // absolute path to scratch/

// Throws immediately on unknown sections
ws.dir('nonexistent'); // Error: Unknown section "nonexistent". Available: input, output, ...
```

## Supported formats

### JSON

```ts
await ws.writeJson('output', 'result.json', { score: 0.95 });
const data = await ws.readJson('output', 'result.json', { schema });
```

### JSONL

```ts
await ws.writeJsonl('output', 'log.jsonl', [{ step: 1 }, { step: 2 }]);
const items = await ws.readJsonl('output', 'log.jsonl', { schema });
```

Schema validates each line independently. Errors include the line number:
`"JSONL validation failed at line 3: step must be number"`

### Markdown with YAML frontmatter

```ts
await ws.writeMarkdown('output', 'report.md', {
  frontmatter: { title: 'Report', version: 2 },
  body: '# Summary\n\nAll good.',
});

const doc = await ws.readMarkdown('output', 'report.md', { frontmatterSchema: schema });
doc.frontmatter; // { title: 'Report', version: 2 }
doc.body;        // '# Summary\n\nAll good.\n'
```

### Raw text

```ts
await ws.writeRaw('scratch', 'notes.txt', 'remember this');
const text = await ws.readRaw('scratch', 'notes.txt');
```

### Directory operations

```ts
const files = await ws.listFiles('output');            // recursive listing
const map = await ws.readJsonDir('output', 'results'); // Map<filename, parsed>
await ws.copyDir('resources', 'dataset', '/path/to/source');
await ws.symlink('resources', 'model', '/path/to/weights');
```

## Schemas

The `Schema<T>` interface requires only a `parse` method that returns the validated value or throws:

```ts
interface Schema<T> {
  parse(data: unknown): T;
}
```

This is compatible with Zod, Joi `.parse()`, or any custom implementation:

```ts
import { z } from 'zod';

const ResultSchema = z.object({
  summary: z.string(),
  confidence: z.number().min(0).max(1),
});

const data = await ws.readJson('output', 'result.json', { schema: ResultSchema });
// data is typed as { summary: string; confidence: number }
```

## Output validation

`validateOutput` checks an output spec non-destructively. It never throws — it collects all errors into a structured result.

```ts
const result = await ws.validateOutput({
  files: [
    {
      path: 'result.json',
      format: 'json',
      required: true,
      description: 'Main analysis result',  // included in error messages
      schema: ResultSchema,                  // schema.parse() validation
      validate: (content) => {               // custom callback
        const obj = content as { confidence: number };
        return obj.confidence >= 0.5;        // return false or throw to fail
      },
    },
  ],
});

result.valid;   // boolean
result.errors;  // Array<{ path: string; message: string }>
```

Error types that get reported:
- `"Required file missing (Main analysis result)"` — file doesn't exist
- `"Schema validation failed: confidence must be a number"` — schema.parse() threw
- `"Custom validation returned false"` — validate callback returned false
- `"Custom validation threw: ..."` — validate callback threw
- `"Failed to read file: ..."` — malformed content (e.g., invalid JSON)

## Standalone functions

All I/O functions are also exported as standalone functions that take a directory path instead of a section:

```ts
import { readJson, writeJson, readJsonl, readMarkdown, validateOutput } from 'agent-workspace';

await writeJson('/my/dir', 'data.json', { key: 'value' });
const data = await readJson('/my/dir', 'data.json', { schema });
```

## Error handling

**Readers throw** on any error (missing file, malformed content, schema failure). Catch them for retry logic:

```ts
try {
  const data = await ws.readJson('output', 'result.json', { schema });
} catch (err) {
  // err.message has enough detail to tell the agent what went wrong
  // err.code === 'ENOENT' for missing files
}
```

**`validateOutput` collects** errors without throwing. Use it for batch checking before reading:

```ts
const { valid, errors } = await ws.validateOutput(spec);
if (!valid) {
  // Build a re-prompt from errors
  const feedback = errors.map(e => `- ${e.path}: ${e.message}`).join('\n');
  // Tell the agent to fix these issues and try again
}
```

## License

MIT
