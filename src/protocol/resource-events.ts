/**
 * Mesh-level events for federated resources.
 *
 * Generic shapes shared across resource types (repo, memory_bank, session, etc.).
 * Specific kinds re-export these for convenience but do not own them.
 *
 * Used by hubs that participate in mesh sync to communicate resource lifecycle
 * changes (visibility downgrade / archive / merge) across federated peers.
 */

// ── Event names ───────────────────────────────────────────────────────────────

/** JSON-RPC method / event names for federated resource lifecycle events. */
export const RESOURCE_MESH_EVENTS = {
  REDACTED: 'resource.redacted',
  ARCHIVED: 'resource.archived',
  MERGED: 'resource.merged',
} as const;

export type ResourceMeshEventName =
  (typeof RESOURCE_MESH_EVENTS)[keyof typeof RESOURCE_MESH_EVENTS];

// ── Event payloads (snake_case wire format) ───────────────────────────────────

/**
 * Emitted when a federated resource's visibility is downgraded
 * (e.g. `federated` → `hub_local`). Peers should mark the resource
 * as `redacted_remote` and remove from cross-mesh queries.
 *
 * Best-effort, not cryptographic. See repo-kind.md threat model.
 */
export interface ResourceRedactedEvent {
  /** Resource type (e.g. `'repo'`, `'memory_bank'`). */
  resource_type: string;
  /** Canonical identity URL of the resource. */
  canonical_url: string;
  /** New visibility tier (semantic per resource type). */
  new_visibility: string;
  /** RFC 3339 timestamp when redaction was issued. */
  redacted_at: string;
  /** Hub that issued the redaction. */
  origin_hub_id: string;
}

/**
 * Emitted when a resource is archived. Peers should mark archived
 * but retain the row (resources are never hard-deleted).
 */
export interface ResourceArchivedEvent {
  resource_type: string;
  canonical_url: string;
  archived_at: string;
  origin_hub_id: string;
}

/**
 * Emitted when one resource is merged into another (e.g. duplicate
 * canonical URL cleanup). Peers should reassign references from
 * source to target and tombstone the source row.
 */
export interface ResourceMergedEvent {
  resource_type: string;
  source_canonical_url: string;
  target_canonical_url: string;
  merged_at: string;
  origin_hub_id: string;
}

// ── Federation race resolution ────────────────────────────────────────────────

/**
 * Comparator for federation merge race resolution.
 *
 * Conflicting merges from two hubs apply in deterministic order:
 * lexicographic `(origin_hub_id, merged_at)`. Tombstone pointers always
 * terminate because merges are write-once; the chain follows tombstone
 * redirects to the final survivor.
 *
 * Use as a comparator for `Array.prototype.sort`:
 *   `events.sort(compareMergeEvents)`
 *
 * @returns -1 if a < b, 1 if a > b, 0 if equal
 */
export function compareMergeEvents(
  a: ResourceMergedEvent,
  b: ResourceMergedEvent,
): -1 | 0 | 1 {
  if (a.origin_hub_id < b.origin_hub_id) return -1;
  if (a.origin_hub_id > b.origin_hub_id) return 1;
  if (a.merged_at < b.merged_at) return -1;
  if (a.merged_at > b.merged_at) return 1;
  return 0;
}
