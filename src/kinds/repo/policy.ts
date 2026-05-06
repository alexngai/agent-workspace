/**
 * Pure policy hooks for the repo kind.
 *
 * Visibility math (effective visibility, downgrade/upgrade detection) and
 * federation race ordering. Pure functions — no I/O, no state.
 *
 * The "do you have authority for this transition" question is a hub concern,
 * not a pure function over visibility values; it lives in the consumer's
 * policy stack, not here.
 *
 * See `docs/design/repo-kind.md` "Visibility model" + "Policy hooks" sections.
 */

import type { RepoVisibility } from '../../protocol/repo.js';

// ── Visibility ordering ───────────────────────────────────────────────────────

/**
 * Restrictiveness ranks. Higher = more restricted.
 *
 *   federated (0) ── least restricted (most open)
 *   hub_local (1)
 *   private   (2) ── most restricted
 *
 * `effectiveVisibility` returns the *more restricted* of two values; that
 * means the higher rank. Mode partial order in the design doc reads
 * "least → most restrictive" as `none < advisory < enforce < strict`; for
 * visibility, the same direction is `federated < hub_local < private`.
 */
const RESTRICTIVENESS: Record<RepoVisibility, number> = {
  federated: 0,
  hub_local: 1,
  private: 2,
};

// ── Effective visibility ──────────────────────────────────────────────────────

/**
 * `min(repo, binding)` in the restriction sense — the more restricted tier
 * wins. Used to compute what consumers actually see when both the repo and
 * the binding declare independent visibility tiers.
 *
 * @example
 *   effectiveVisibility('federated', 'private') === 'private'
 *   effectiveVisibility('hub_local', 'federated') === 'hub_local'
 *   effectiveVisibility('private', 'hub_local') === 'private'
 */
export function effectiveVisibility(
  repo: RepoVisibility,
  binding: RepoVisibility,
): RepoVisibility {
  return RESTRICTIVENESS[repo] >= RESTRICTIVENESS[binding] ? repo : binding;
}

// ── Transition direction ─────────────────────────────────────────────────────

/** True iff `to` is strictly more restricted than `from`. */
export function isVisibilityDowngrade(
  from: RepoVisibility,
  to: RepoVisibility,
): boolean {
  return RESTRICTIVENESS[to] > RESTRICTIVENESS[from];
}

/** True iff `to` is strictly more open than `from`. */
export function isVisibilityUpgrade(
  from: RepoVisibility,
  to: RepoVisibility,
): boolean {
  return RESTRICTIVENESS[to] < RESTRICTIVENESS[from];
}

// ── Re-export for convenience ────────────────────────────────────────────────

/**
 * Comparator for federation merge race resolution. Re-exported here so the
 * full policy surface is reachable from one place.
 */
export { compareMergeEvents } from '../../protocol/resource-events.js';
