/**
 * Minimal schema interface — anything with a `parse` method works (Zod, Joi, custom).
 * `parse` should throw on invalid data.
 */
export interface Schema<T = unknown> {
  parse(data: unknown): T;
}

/** Options for creating a workspace. */
export interface CreateWorkspaceOptions {
  /** Extra top-level directories to create alongside the defaults. */
  additionalDirs?: string[];
  /** Enable sandbox isolation for commands run in this workspace. */
  sandbox?: SandboxConfig;
}

/** Configuration for WorkspaceManager. */
export interface WorkspaceManagerConfig {
  /** Base directory where workspaces are created. Defaults to `os.tmpdir()`. */
  baseDir?: string;
  /** Namespace prefix for the workspaces directory. Defaults to `'agent-workspaces'`. */
  prefix?: string;
}

/** Metadata persisted alongside a workspace. */
export interface WorkspaceMeta {
  id: string;
  taskType: string;
  createdAt: string;
  dirs: string[];
}

/** Markdown document with optional YAML frontmatter. */
export interface MarkdownDocument<T = Record<string, unknown>> {
  frontmatter: T;
  body: string;
}

/** Specification for a single expected output file. */
export interface OutputFileSpec {
  /** Path relative to the output directory. */
  path: string;
  /** Expected file format. */
  format: 'json' | 'jsonl' | 'markdown' | 'raw';
  /** Whether the file must exist. */
  required: boolean;
  /** Human-readable description (included in error messages). */
  description?: string;
  /** Schema for JSON / JSONL validation — must have a `parse` method that throws on invalid data. */
  schema?: Schema;
  /** Custom validation function. Throw or return false to indicate failure. */
  validate?: (content: unknown) => boolean | Promise<boolean>;
}

/** Full output specification. */
export interface OutputSpec {
  files: OutputFileSpec[];
}

/** A single validation error. */
export interface ValidationError {
  path: string;
  message: string;
}

/** Result of output validation. */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// -- Sandbox types --

/** Network restrictions for sandboxed workspaces. */
export interface SandboxNetworkConfig {
  /** Domains the sandbox is allowed to reach (e.g. `["github.com", "*.npmjs.org"]`). */
  allowedDomains?: string[];
  /** Domains explicitly blocked. */
  deniedDomains?: string[];
  /** Allow binding to localhost ports inside the sandbox. */
  allowLocalBinding?: boolean;
}

/** Extra filesystem restrictions beyond the workspace-scoped defaults. */
export interface SandboxFilesystemConfig {
  /** Additional paths to deny reading (e.g. `["~/.ssh"]`). */
  denyRead?: string[];
  /** Paths to re-allow within denied regions. */
  allowRead?: string[];
  /** Additional writable paths outside the workspace. */
  extraWritePaths?: string[];
  /** Paths to deny writing even inside writable regions. */
  denyWrite?: string[];
}

/** Configuration for enabling sandbox isolation on a workspace. */
export interface SandboxConfig {
  /** Enable sandbox isolation. */
  enabled: boolean;
  /** Network restrictions. Defaults to no network access. */
  network?: SandboxNetworkConfig;
  /** Additional filesystem restrictions beyond workspace-scoped defaults. */
  filesystem?: SandboxFilesystemConfig;
  /** Allow weaker nested sandbox (e.g. inside Docker). */
  enableWeakerNestedSandbox?: boolean;
}
