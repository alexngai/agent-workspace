/**
 * Repo workspace kind — public surface.
 *
 * Single import surface for consumers:
 *   `import { canonicalizeRepoUrl, RepoConfig, ... } from 'agent-workspace/kinds/repo'`
 *
 * See `docs/design/repo-kind.md` for the full design and lifecycle flows.
 *
 * Slice 1 (this file): canonical-URL utility, in-memory types, error hierarchy,
 * wire protocol re-exports for convenience. Subsequent slices add the manager,
 * client, server, wire translators, policy hooks, and testing utilities.
 */

// ── Identity (canonical URL utility) ──────────────────────────────────────────

export {
  canonicalizeRepoUrl,
  tryCanonicalizeRepoUrl,
  isSimilarRepoUrl,
  setRepoIdentityConfig,
  getRepoIdentityConfig,
} from '../../lib/canonical-url.js';
export type {
  CanonicalRepoIdentity,
  RepoIdentityConfig,
} from '../../lib/canonical-url.js';

// ── In-memory types ───────────────────────────────────────────────────────────

export type {
  RepoConfig,
  RepoHandle,
  RepoVisibility,
} from './types.js';

// ── Errors ────────────────────────────────────────────────────────────────────

export {
  RepoError,
  InvalidRepoUrlError,
  PolicyViolationError,
  CapabilityError,
  NotAttachedError,
} from './errors.js';

// ── Wire ↔ in-memory translators ──────────────────────────────────────────────

export {
  toWireDeclare,
  fromWireDeclare,
  toWireChanged,
  fromWireChanged,
} from './wire.js';
export type {
  RepoChangedDiff,
  RepoChangedRemoval,
} from './wire.js';

// ── Policy hooks (pure visibility math + federation ordering) ─────────────────

export {
  effectiveVisibility,
  isVisibilityDowngrade,
  isVisibilityUpgrade,
} from './policy.js';
// `compareMergeEvents` is also exported via policy.ts; the protocol re-export
// below already covers it, so we don't duplicate the export here.

// ── Manager (lifecycle: attach / detach / list / find) ────────────────────────

export { RepoManager } from './manager.js';
export type { RepoManagerConfig } from './manager.js';

// `RepoHandleImpl` (the concrete class) is intentionally NOT exported.
// Consumers interact via the `RepoHandle` interface from `./types.js`.

// ── Agent-side client (transport wrapper) ─────────────────────────────────────

export { RepoClient } from './client.js';
export type {
  RepoClientTransport,
  RepoClientOptions,
} from './client.js';

// ── Server-side handler interface (hubs implement) ────────────────────────────

export { registerRepoHandlers } from './server.js';
export type {
  RepoProtocolHandler,
  RepoHandlerContext,
  RepoMethodServer,
} from './server.js';

// ── Protocol shapes (re-export for convenience) ───────────────────────────────

export {
  REPO_METHODS,
  REPO_PROTOCOL_VERSION,
  RESOURCE_MESH_EVENTS,
  compareMergeEvents,
} from '../../protocol/repo.js';

export type {
  RepoMethodName,
  WorkspaceDeclareInput,
  RepoDeclareParams,
  RepoChangedParams,
  RepoListParams,
  RepoListResult,
  RepoRetractParams,
  WorkspaceCapability,
  ResourceMeshEventName,
  ResourceRedactedEvent,
  ResourceArchivedEvent,
  ResourceMergedEvent,
} from '../../protocol/repo.js';
