/**
 * In-memory types for the repo kind (camelCase).
 *
 * Wire shapes live in `src/protocol/repo.ts` (snake_case). Translators
 * between the two boundaries will live in `src/kinds/repo/wire.ts`.
 *
 * See `docs/design/repo-kind.md` for the API design.
 */

import type { CanonicalRepoIdentity } from '../../lib/canonical-url.js';
import type { RepoVisibility } from '../../protocol/repo.js';

// ── Re-export identity + visibility for convenience ───────────────────────────

export type { CanonicalRepoIdentity } from '../../lib/canonical-url.js';
export type { RepoVisibility } from '../../protocol/repo.js';

// ── Configuration (declarative) ───────────────────────────────────────────────

/**
 * Declarative configuration for attaching to a local repo clone.
 * The manager canonicalizes `remoteUrl` internally; callers can pass raw input.
 */
export interface RepoConfig {
  /** Raw or canonical URL. The manager canonicalizes. */
  remoteUrl: string;
  /** Absolute path to the local clone on disk. */
  localPath: string;
  /** Current branch, if known. The manager can refresh from disk. */
  currentBranch?: string;
  /** HEAD sha, if known. The manager can refresh from disk. */
  headSha?: string;
  /** Visibility tier; defaults applied per-agent capability. */
  visibility?: RepoVisibility;
  /** Optional human-readable disambiguator for multiple bindings on the same `(agent, repo)`. */
  instanceLabel?: string;
}

// ── Runtime handle ────────────────────────────────────────────────────────────

/**
 * Runtime handle for one attached repo workspace.
 *
 * Snapshot fields (`currentBranch`, `headSha`, `dirty`) are fast reads that may
 * be stale until `refresh()` is called. Use `inspectGit()` for a one-shot fresh
 * read that doesn't mutate the snapshot.
 */
export interface RepoHandle {
  readonly identity: CanonicalRepoIdentity;
  readonly localPath: string;

  // Snapshot fields — fast reads, may be stale until refresh().
  readonly currentBranch: string | undefined;
  readonly headSha: string | undefined;
  readonly dirty: boolean;
  readonly visibility: RepoVisibility;
  readonly instanceLabel: string | undefined;

  /** Re-read git state from disk and update the snapshot in place. */
  refresh(): Promise<void>;

  /**
   * Re-read git state and return fresh values without mutating the snapshot.
   * Use for one-shot checks where mutating shared state would surprise readers.
   */
  inspectGit(): Promise<{
    currentBranch: string | undefined;
    headSha: string | undefined;
    dirty: boolean;
  }>;

  /**
   * Update visibility (downgrades only — upgrades require external authority).
   * Throws PolicyViolationError on attempted upgrade without authority.
   */
  retract(toVisibility: RepoVisibility): Promise<void>;

  /**
   * Section accessor inherited from base WorkspaceHandle. For repo workspaces
   * the section namespace typically includes 'repo' (clone path), 'output',
   * and any custom sections declared at attach time.
   */
  dir(section: string): string;
}
