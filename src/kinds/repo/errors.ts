/**
 * Error hierarchy for the repo kind.
 *
 * Hubs translate to JSON-RPC error codes; consumers pattern-match on `.code`.
 * See `docs/design/repo-kind.md` Errors section.
 *
 * `InvalidRepoUrlError` is re-exported from `lib/canonical-url` so it shares
 * the abstract `RepoError` parent — the canonicalize utility throws it
 * directly without needing to import this module.
 */

// Re-export so InvalidRepoUrlError is part of the same hierarchy.
export { InvalidRepoUrlError } from '../../lib/canonical-url.js';

// ── Hierarchy root ────────────────────────────────────────────────────────────

/**
 * Base class for all repo-kind errors. The `code` field is the stable
 * machine-readable identifier consumers should pattern-match on.
 */
export abstract class RepoError extends Error {
  abstract readonly code: string;
}

// ── Concrete errors ───────────────────────────────────────────────────────────

/**
 * Thrown when a declare/changed/retract attempt is rejected by one of the
 * enforcement layers (hub policy, repo binding policy, swarm policy, agent
 * privacy). The `layer` identifies which gate rejected; `detail` is a
 * human-readable explanation suitable for surfacing to the agent.
 */
export class PolicyViolationError extends RepoError {
  readonly code = 'policy_violation' as const;

  constructor(
    public readonly layer: 'hub' | 'repo' | 'swarm' | 'agent',
    public readonly detail: string,
  ) {
    super(`Policy violation at ${layer} layer: ${detail}`);
    this.name = 'PolicyViolationError';
  }
}

/**
 * Thrown when an operation requires a capability the calling agent has not
 * declared (e.g., trying to use `workspace/repo.list` against an agent whose
 * `WorkspaceCapability.list.enabled` is false).
 */
export class CapabilityError extends RepoError {
  readonly code = 'capability' as const;

  constructor(public readonly missing: string[]) {
    super(`Missing required capability: ${missing.join(', ')}`);
    this.name = 'CapabilityError';
  }
}

/**
 * Thrown by `RepoManager.detach()` (and similar lookups) when the supplied
 * handle or `(canonicalUrl, localPath)` pair does not match an attached
 * binding.
 */
export class NotAttachedError extends RepoError {
  readonly code = 'not_attached' as const;

  constructor(
    public readonly canonicalUrl: string,
    public readonly localPath: string,
  ) {
    super(`No attached repo workspace at ${localPath} for ${canonicalUrl}`);
    this.name = 'NotAttachedError';
  }
}
