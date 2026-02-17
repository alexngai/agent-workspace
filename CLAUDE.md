# CLAUDE.md

## Project overview

`agent-workspace` is a TypeScript library for managing filesystem workspaces used by AI agents. It provides structured directory layouts, typed readers/writers (JSON, JSONL, Markdown with YAML frontmatter, raw text), and output validation with structured error collection.

## Commands

- `npm test` — run all tests (vitest)
- `npm run test:watch` — run tests in watch mode
- `npm run build` — build with tsup (outputs to `dist/`)
- `npm run typecheck` — type-check without emitting

## Architecture

```
src/
  index.ts          ← public API, re-exports everything
  types.ts          ← all shared types (Schema, OutputSpec, ValidationResult, etc.)
  manager.ts        ← WorkspaceManager: create, list, cleanup, pruneStale
  handle.ts         ← WorkspaceHandle: section-scoped I/O facade over readers/writers
  validation.ts     ← validateOutput: non-throwing batch output checker
  readers/
    json.ts         ← readJson, readJsonl, readJsonDir
    markdown.ts     ← readMarkdown (with YAML frontmatter parsing via `yaml` package)
    raw.ts          ← readRaw, listFiles
  writers/
    json.ts         ← writeJson, writeJsonl
    markdown.ts     ← writeMarkdown (with YAML frontmatter serialization)
    raw.ts          ← writeRaw, copyDir, symlink

tests/
  readers.test.ts   ← standalone reader function tests
  writers.test.ts   ← standalone writer function tests
  handle.test.ts    ← WorkspaceHandle round-trip and section tests
  manager.test.ts   ← WorkspaceManager lifecycle tests
  validation.test.ts ← validateOutput tests
  errors.test.ts    ← comprehensive parse/validation error behavior tests
```

## Key design decisions

- **Two error strategies**: Reader functions **throw** on errors (for try/catch recovery). `validateOutput` **collects** errors into `{ valid, errors }` (for batch checking). Never mix these — readers always throw, validation never throws.
- **Schema interface**: `{ parse(data: unknown): T }` — deliberately minimal so it works with Zod, Joi, or any custom implementation. `parse` must throw on invalid data.
- **Section-scoped I/O**: `WorkspaceHandle` methods take a section name (`'input'`, `'output'`, `'resources'`, `'scratch'`, or custom) as the first argument. `handle.dir(section)` throws synchronously if the section is unknown.
- **Default dirs**: `input`, `output`, `resources`, `scratch` are always created. Additional dirs are specified at `manager.create()` time.
- **Workspace metadata**: Each workspace writes `.workspace.json` with `{ id, taskType, createdAt, dirs }`. The manager uses this to reconstruct handles when listing.

## Conventions

- ESM-first (`"type": "module"` in package.json), dual CJS/ESM output via tsup.
- All file path parameters in readers/writers are relative to the `dir` argument. Writers auto-create parent directories via `fs.mkdir({ recursive: true })`.
- Tests use temp directories (`os.tmpdir()` + `fs.mkdtemp`) and clean up in `afterEach`.
- No external dependencies except `yaml` for YAML parsing/serialization.
- TypeScript strict mode. Target ES2022.

## Error message contracts

Error messages are intentionally detailed to support agent re-prompting:

- `readJson` on bad JSON: native `JSON.parse` SyntaxError
- `readJson` schema failure: the schema's own error message (e.g., Zod's)
- `readJsonl` schema failure: `"JSONL validation failed at line N: <schema error>"`
- `handle.dir()` unknown section: `'Unknown section "X". Available: input, output, ...'`
- `validateOutput` errors: `{ path: string, message: string }` — path identifies the file, message describes the issue

## Testing

The test suite has 101 tests across 6 files. When adding new functionality:

- Add happy-path tests to the relevant existing test file (`readers.test.ts`, `handle.test.ts`, etc.)
- Add error/throw behavior tests to `errors.test.ts`
- All reader error paths must be tested: missing file, malformed content, schema rejection
- Validation tests must verify that errors are **collected** (not thrown) and include both `path` and `message`
