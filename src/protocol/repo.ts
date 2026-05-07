/**
 * Repo kind wire protocol.
 *
 * JSON-RPC method names and request/response shapes for the four
 * `x-workspace/repo.*` methods, plus mesh-level event re-exports
 * for federation, plus the `WorkspaceCapability` declaration shape
 * advertised at MAP registration.
 *
 * See `references/agent-workspace/docs/design/repo-kind.md` for the
 * full design and lifecycle flows.
 *
 * **Naming convention** (cf. repo-kind.md):
 * - JSON-RPC params/results use **snake_case** (wire convention).
 * - `WorkspaceCapability` uses **camelCase** as a deliberate exception:
 *   it rides the MAP `ParticipantCapabilities` envelope, which is camelCase.
 */

// ── Versioning ────────────────────────────────────────────────────────────────

export const REPO_PROTOCOL_VERSION = '1' as const;

// ── Method names ──────────────────────────────────────────────────────────────

export const REPO_METHODS = {
  /** agent → hub: push initial set or additions. */
  DECLARE: 'x-workspace/repo.declare',
  /** agent → hub: incremental diffs (LSP `didChangeWorkspaceFolders` style). */
  CHANGED: 'x-workspace/repo.changed',
  /** hub → agent: pull current set (reconciliation). */
  LIST: 'x-workspace/repo.list',
  /** agent → hub: downgrade own bindings to private. */
  RETRACT: 'x-workspace/repo.retract',
} as const;

export type RepoMethodName = (typeof REPO_METHODS)[keyof typeof REPO_METHODS];

// ── Visibility ────────────────────────────────────────────────────────────────

export type RepoVisibility = 'private' | 'hub_local' | 'federated';

// ── Wire types (snake_case) ───────────────────────────────────────────────────

/**
 * Wire shape for one declared workspace binding.
 * `remote_url` is raw — the hub canonicalizes via `canonicalizeRepoUrl`.
 */
export interface WorkspaceDeclareInput {
  remote_url: string;
  local_path: string;
  current_branch?: string;
  head_sha?: string;
  dirty?: boolean;
  visibility?: RepoVisibility;
  instance_label?: string;
}

export interface RepoDeclareParams {
  workspaces: WorkspaceDeclareInput[];
}

export interface RepoChangedParams {
  added?: WorkspaceDeclareInput[];
  removed?: Array<{
    canonical_url: string;
    local_path: string;
  }>;
}

export interface RepoListParams {
  filter?: {
    canonical_url?: string;
  };
}

export interface RepoListResult {
  workspaces: WorkspaceDeclareInput[];
}

export interface RepoRetractParams {
  canonical_url: string;
  /** Omit to retract all bindings for this repo on the calling agent. */
  local_path?: string;
}

// ── Capability declaration (camelCase per MAP convention) ─────────────────────

/**
 * Per-agent capability declaration for the repo kind. Rides the MAP
 * `ParticipantCapabilities` envelope at registration. Hub uses these
 * fields to gate behavior:
 *
 * - `declare.enabled: false` ⇒ hub never sees this agent's repo declarations.
 *   Trajectory-handler bootstrap (which infers from checkpoint metadata)
 *   must also respect this flag.
 *
 * - `declare.maxVisibility` is a hard ceiling: agent will never declare
 *   above this visibility, even if a feature asks for it.
 *
 * - `list.enabled` controls whether the agent answers hub-initiated
 *   `x-workspace/repo.list` pulls.
 */
export interface WorkspaceCapability {
  /** Must equal the protocol major version this agent speaks. */
  protocolVersion: string;

  declare: {
    /** Master switch. False ⇒ hub never sees this agent's repos. */
    enabled: boolean;
    /** Default visibility applied when a declare omits explicit visibility. */
    defaultVisibility: RepoVisibility;
    /** Hard cap; agent will never declare above this. Optional. */
    maxVisibility?: RepoVisibility;
  };

  list: {
    /** Whether the agent answers x-workspace/repo.list pulls. */
    enabled: boolean;
  };

  // Future: changed / retract may be promoted to first-class fields if
  // independent control becomes useful. v1 derives them from declare.enabled.
}

// ── Re-exports for convenience ────────────────────────────────────────────────

// Federated resource events (redacted/archived/merged) live in
// protocol/resource-events because they're shared across resource types,
// but consumers of the repo kind typically want them all from one place.
export {
  RESOURCE_MESH_EVENTS,
  compareMergeEvents,
} from './resource-events.js';
export type {
  ResourceMeshEventName,
  ResourceRedactedEvent,
  ResourceArchivedEvent,
  ResourceMergedEvent,
} from './resource-events.js';
