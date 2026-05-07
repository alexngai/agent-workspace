/**
 * Wire ↔ in-memory translators for the repo kind.
 *
 * In-memory types use camelCase (`RepoConfig`); wire types use snake_case
 * (`WorkspaceDeclareInput`). These functions are the explicit boundary
 * between the two — every consumer that crosses the boundary uses these
 * helpers rather than reimplementing the conversion.
 *
 * Pure functions. No I/O, no side effects.
 *
 * See `docs/design/repo-kind.md` "Wire ↔ in-memory translators" section.
 */

import type { RepoConfig } from './types.js';
import type {
  WorkspaceDeclareInput,
  RepoChangedParams,
} from '../../protocol/repo.js';

// ── Declare ───────────────────────────────────────────────────────────────────

/**
 * Convert in-memory `RepoConfig` array to wire `WorkspaceDeclareInput` array.
 *
 * `RepoConfig` does not carry a `dirty` flag (it's a declarative shape, not
 * runtime state); the produced wire entries omit it. Callers that need `dirty`
 * in the wire (typically because they're emitting from a `RepoHandle`) can
 * post-process or use a future handle-aware helper.
 */
export function toWireDeclare(
  configs: readonly RepoConfig[],
): WorkspaceDeclareInput[] {
  return configs.map(toWireDeclareOne);
}

function toWireDeclareOne(c: RepoConfig): WorkspaceDeclareInput {
  const out: WorkspaceDeclareInput = {
    remote_url: c.remoteUrl,
    local_path: c.localPath,
  };
  if (c.currentBranch !== undefined) out.current_branch = c.currentBranch;
  if (c.headSha !== undefined) out.head_sha = c.headSha;
  if (c.visibility !== undefined) out.visibility = c.visibility;
  if (c.instanceLabel !== undefined) out.instance_label = c.instanceLabel;
  return out;
}

/**
 * Convert wire `WorkspaceDeclareInput` array to in-memory `RepoConfig` array.
 * The wire `dirty` field is dropped — `RepoConfig` is declarative.
 */
export function fromWireDeclare(
  wire: readonly WorkspaceDeclareInput[],
): RepoConfig[] {
  return wire.map(fromWireDeclareOne);
}

function fromWireDeclareOne(w: WorkspaceDeclareInput): RepoConfig {
  const out: RepoConfig = {
    remoteUrl: w.remote_url,
    localPath: w.local_path,
  };
  if (w.current_branch !== undefined) out.currentBranch = w.current_branch;
  if (w.head_sha !== undefined) out.headSha = w.head_sha;
  if (w.visibility !== undefined) out.visibility = w.visibility;
  if (w.instance_label !== undefined) out.instanceLabel = w.instance_label;
  return out;
}

// ── Changed (diff) ────────────────────────────────────────────────────────────

/** In-memory representation of a removed binding (camelCase). */
export interface RepoChangedRemoval {
  canonicalUrl: string;
  localPath: string;
}

/** In-memory representation of a `repo.changed` diff. */
export interface RepoChangedDiff {
  added?: readonly RepoConfig[];
  removed?: readonly RepoChangedRemoval[];
}

/** Convert in-memory diff to wire `RepoChangedParams`. */
export function toWireChanged(diff: RepoChangedDiff): RepoChangedParams {
  const out: RepoChangedParams = {};
  if (diff.added && diff.added.length > 0) {
    out.added = toWireDeclare(diff.added);
  }
  if (diff.removed && diff.removed.length > 0) {
    out.removed = diff.removed.map((r) => ({
      canonical_url: r.canonicalUrl,
      local_path: r.localPath,
    }));
  }
  return out;
}

/** Convert wire `RepoChangedParams` to an in-memory diff. */
export function fromWireChanged(
  wire: RepoChangedParams,
): { added: RepoConfig[]; removed: RepoChangedRemoval[] } {
  return {
    added: wire.added ? fromWireDeclare(wire.added) : [],
    removed: wire.removed
      ? wire.removed.map((r) => ({
          canonicalUrl: r.canonical_url,
          localPath: r.local_path,
        }))
      : [],
  };
}
