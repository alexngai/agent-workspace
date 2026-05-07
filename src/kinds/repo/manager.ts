/**
 * RepoManager — local-only registry of attached repo workspaces.
 *
 * Lifecycle is `attach` / `detach`, not `create` / `cleanup` (since repo
 * workspaces are persistent, not ephemeral). The manager holds in-memory
 * state only; consumers re-attach on process restart.
 *
 * Binding key: `(canonicalUrl, resolved-absolute-localPath)`. Two clones of
 * the same repo at different paths get separate bindings; one clone with
 * multiple remotes (`origin`, `upstream`) gets separate bindings sharing
 * `localPath` but with different `canonicalUrl`.
 */

import * as path from 'node:path';

import type { RepoConfig, RepoHandle } from './types.js';
import { canonicalizeRepoUrl } from '../../lib/canonical-url.js';
import { RepoHandleImpl } from './handle.js';
import { NotAttachedError } from './errors.js';
import { inspectGitState, type GitInspectionResult } from './git-inspect.js';

export interface RepoManagerConfig {
  /**
   * Run git inspection on `attach()` to populate `currentBranch` / `headSha`
   * / `dirty` from disk. Default: `true`.
   *
   * Set `false` to skip inspection; the manager then uses the values supplied
   * in `RepoConfig` (and `dirty` defaults to `false` since `RepoConfig` does
   * not carry it).
   */
  inspectGitOnAttach?: boolean;
}

export class RepoManager {
  private readonly inspectOnAttach: boolean;
  private readonly bindings: Map<string, RepoHandleImpl> = new Map();

  constructor(config: RepoManagerConfig = {}) {
    this.inspectOnAttach = config.inspectGitOnAttach ?? true;
  }

  /**
   * Attach to an existing local clone. Idempotent: calling twice with the same
   * `(canonicalUrl, localPath)` returns the existing handle reference, with
   * its metadata refreshed from the new config.
   *
   * `remoteUrl` may be raw — the manager canonicalizes via `canonicalizeRepoUrl`.
   * `localPath` is resolved to an absolute path before keying.
   *
   * @throws InvalidRepoUrlError if `config.remoteUrl` is malformed
   */
  async attach(config: RepoConfig): Promise<RepoHandle> {
    const identity = canonicalizeRepoUrl(config.remoteUrl);
    const absLocalPath = path.resolve(config.localPath);
    const key = bindingKey(identity.canonicalUrl, absLocalPath);

    const inspection = await this.gatherInspection(absLocalPath, config);

    const existing = this.bindings.get(key);
    if (existing) {
      existing._updateFromConfig(config, inspection);
      return existing;
    }

    const handle = new RepoHandleImpl(identity, absLocalPath, {
      currentBranch: inspection.currentBranch,
      headSha: inspection.headSha,
      dirty: inspection.dirty,
      visibility: config.visibility,
      instanceLabel: config.instanceLabel,
    });
    this.bindings.set(key, handle);
    return handle;
  }

  /**
   * Detach from an attached workspace. Non-destructive: does NOT delete the
   * clone — only releases the in-memory handle.
   *
   * @throws NotAttachedError if no binding matches the handle
   */
  async detach(handle: RepoHandle): Promise<void> {
    const key = bindingKey(handle.identity.canonicalUrl, handle.localPath);
    if (!this.bindings.has(key)) {
      throw new NotAttachedError(handle.identity.canonicalUrl, handle.localPath);
    }
    this.bindings.delete(key);
  }

  /** All currently-attached repo handles. */
  list(): RepoHandle[] {
    return Array.from(this.bindings.values());
  }

  /**
   * Look up an attached handle by canonical URL + local path.
   * The provided `localPath` is resolved to absolute before matching.
   */
  find(canonicalUrl: string, localPath: string): RepoHandle | undefined {
    const absPath = path.resolve(localPath);
    return this.bindings.get(bindingKey(canonicalUrl, absPath));
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async gatherInspection(
    absLocalPath: string,
    config: RepoConfig,
  ): Promise<GitInspectionResult> {
    if (!this.inspectOnAttach) {
      return {
        currentBranch: config.currentBranch,
        headSha: config.headSha,
        dirty: false,
      };
    }
    const live = await inspectGitState(absLocalPath);
    // Live inspection is authoritative; config-supplied values are used only
    // as a fallback when the live values are undefined (e.g. detached HEAD).
    return {
      currentBranch: live.currentBranch ?? config.currentBranch,
      headSha: live.headSha ?? config.headSha,
      dirty: live.dirty,
    };
  }
}

function bindingKey(canonicalUrl: string, absLocalPath: string): string {
  return `${canonicalUrl}\x00${absLocalPath}`;
}
