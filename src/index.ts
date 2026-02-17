// Core classes
export { WorkspaceManager } from './manager.js';
export { WorkspaceHandle } from './handle.js';

// Validation
export { validateOutput } from './validation.js';

// Standalone writer functions (for consumers who manage their own dirs)
export { writeJson, writeJsonl } from './writers/json.js';
export { writeMarkdown } from './writers/markdown.js';
export { writeRaw, copyDir, symlink } from './writers/raw.js';

// Standalone reader functions
export { readJson, readJsonl, readJsonDir } from './readers/json.js';
export { readMarkdown } from './readers/markdown.js';
export { readRaw, listFiles } from './readers/raw.js';

// Types
export type {
  Schema,
  CreateWorkspaceOptions,
  WorkspaceManagerConfig,
  WorkspaceMeta,
  MarkdownDocument,
  OutputFileSpec,
  OutputSpec,
  ValidationError,
  ValidationResult,
} from './types.js';

export type { ReadJsonOptions } from './readers/json.js';
export type { ReadMarkdownOptions } from './readers/markdown.js';
