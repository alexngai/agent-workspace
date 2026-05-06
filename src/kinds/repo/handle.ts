/**
 * Concrete implementation of the `RepoHandle` interface.
 *
 * Snapshot fields (`currentBranch`, `headSha`, `dirty`) are mutable internally
 * via private fields; exposed as `readonly` getters. `refresh()` re-runs git
 * inspection and mutates the snapshot in place; `inspectGit()` returns fresh
 * values without mutating.
 *
 * `RepoManager` calls the internal `_updateFromConfig` method on idempotent
 * re-attach to refresh metadata without replacing the handle reference.
 */

import type { RepoHandle, RepoConfig, RepoVisibility } from './types.js';
import type { CanonicalRepoIdentity } from '../../lib/canonical-url.js';
import { isVisibilityUpgrade } from './policy.js';
import { PolicyViolationError } from './errors.js';
import { inspectGitState, type GitInspectionResult } from './git-inspect.js';

export interface RepoHandleInit {
  currentBranch?: string;
  headSha?: string;
  dirty?: boolean;
  visibility?: RepoVisibility;
  instanceLabel?: string;
}

export class RepoHandleImpl implements RepoHandle {
  readonly identity: CanonicalRepoIdentity;
  readonly localPath: string;

  private _currentBranch: string | undefined;
  private _headSha: string | undefined;
  private _dirty: boolean;
  private _visibility: RepoVisibility;
  private _instanceLabel: string | undefined;

  constructor(
    identity: CanonicalRepoIdentity,
    localPath: string,
    init: RepoHandleInit = {},
  ) {
    this.identity = identity;
    this.localPath = localPath;
    this._currentBranch = init.currentBranch;
    this._headSha = init.headSha;
    this._dirty = init.dirty ?? false;
    this._visibility = init.visibility ?? 'hub_local';
    this._instanceLabel = init.instanceLabel;
  }

  // ── Snapshot accessors ──────────────────────────────────────────────────────

  get currentBranch(): string | undefined { return this._currentBranch; }
  get headSha(): string | undefined { return this._headSha; }
  get dirty(): boolean { return this._dirty; }
  get visibility(): RepoVisibility { return this._visibility; }
  get instanceLabel(): string | undefined { return this._instanceLabel; }

  // ── Behavior ────────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    const state = await inspectGitState(this.localPath);
    this._currentBranch = state.currentBranch;
    this._headSha = state.headSha;
    this._dirty = state.dirty;
  }

  async inspectGit(): Promise<GitInspectionResult> {
    return inspectGitState(this.localPath);
  }

  async retract(toVisibility: RepoVisibility): Promise<void> {
    if (isVisibilityUpgrade(this._visibility, toVisibility)) {
      throw new PolicyViolationError(
        'agent',
        `Cannot upgrade visibility from "${this._visibility}" to "${toVisibility}" via retract; ` +
        `upgrades require external authority.`,
      );
    }
    this._visibility = toVisibility;
  }

  /**
   * Returns the absolute path for a named section.
   *
   * v0.4 only supports the `'repo'` section, which resolves to `localPath`.
   * The full virtual-section model (`subdir | mount | reference`) lands when
   * the architecture's Section generalization (D5) is implemented.
   */
  dir(section: string): string {
    if (section === 'repo') return this.localPath;
    throw new Error(
      `Unknown section "${section}". Available: repo. ` +
      `(Full virtual-section model is deferred to architecture D5.)`,
    );
  }

  // ── Internal: used by RepoManager for idempotent re-attach ──────────────────

  /**
   * @internal Updates metadata + snapshot fields in place without replacing
   * the handle reference. Used by `RepoManager.attach()` when the same
   * `(canonicalUrl, localPath)` pair is attached twice.
   *
   * `identity` and `localPath` are immutable; the manager is responsible
   * for matching before calling.
   */
  _updateFromConfig(
    config: RepoConfig,
    inspection?: Partial<GitInspectionResult>,
  ): void {
    if (config.visibility !== undefined) this._visibility = config.visibility;
    if (config.instanceLabel !== undefined) this._instanceLabel = config.instanceLabel;
    if (inspection) {
      if ('currentBranch' in inspection) this._currentBranch = inspection.currentBranch;
      if ('headSha' in inspection) this._headSha = inspection.headSha;
      if (inspection.dirty !== undefined) this._dirty = inspection.dirty;
    }
  }
}
