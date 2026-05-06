/**
 * Wire protocol shapes for cross-process workspace operations.
 *
 * Per-domain modules:
 * - `protocol/task` — `x-workspace/task.*` methods (task execution)
 * - `protocol/resource-events` — generic federated resource events
 *   (`resource.redacted` / `archived` / `merged`)
 * - `protocol/repo` — `x-workspace/repo.*` methods (repo kind) and
 *   the `WorkspaceCapability` declaration shape
 *
 * Future modules: `protocol/environment`, `protocol/sandbox`. See
 * `docs/design/architecture.md` decision D7.
 */

export * from './task.js';
export * from './resource-events.js';
export * from './repo.js';
