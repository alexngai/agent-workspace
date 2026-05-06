/**
 * Agent-side `RepoClient` — wraps a JSON-RPC transport with the four
 * `x-workspace/repo.*` methods, plus inbound dispatch for hub-initiated
 * `repo.list` pulls.
 *
 * The client is I/O-free: it translates between in-memory shapes and wire
 * shapes (via `wire.ts`) and hands work to the transport. The transport
 * itself owns the actual JSON-RPC framing.
 *
 * See `docs/design/repo-kind.md` "Agent-side client (`RepoClient`)" section.
 */

import type {
  RepoListParams,
  RepoListResult,
  WorkspaceDeclareInput,
} from '../../protocol/repo.js';
import { REPO_METHODS } from '../../protocol/repo.js';
import { CapabilityError } from './errors.js';
import { toWireDeclare, toWireChanged, type RepoChangedDiff } from './wire.js';
import type { RepoConfig } from './types.js';
import type { RepoManager } from './manager.js';

// ── Transport contract ────────────────────────────────────────────────────────

/**
 * Minimal JSON-RPC-shaped transport the `RepoClient` needs.
 *
 * - `notify` is fire-and-forget (used for declare / changed / retract).
 * - `request` awaits a typed response (currently unused by the client; included
 *   for symmetry and future protocol additions).
 * - `onRequest` is optional: if the transport supports installing per-method
 *   request handlers, the client will self-install for `repo.list`. Transports
 *   without this capability require the consumer to wire `client.handleList`
 *   manually into their dispatch.
 */
export interface RepoClientTransport {
  notify(method: string, params: unknown): Promise<void>;
  request<T>(method: string, params: unknown): Promise<T>;
  /** Optional: install a handler for an inbound request method. */
  onRequest?(
    method: string,
    handler: (params: unknown) => Promise<unknown>,
  ): void;
}

export interface RepoClientOptions {
  /** Handler invoked when the hub sends `x-workspace/repo.list`. */
  onList?: (params: RepoListParams) => Promise<RepoListResult>;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class RepoClient {
  private readonly transport: RepoClientTransport;
  private readonly onListHandler: RepoClientOptions['onList'];

  constructor(transport: RepoClientTransport, options: RepoClientOptions = {}) {
    this.transport = transport;
    this.onListHandler = options.onList;

    // Auto-install onList if the transport supports it.
    if (transport.onRequest && this.onListHandler) {
      transport.onRequest(REPO_METHODS.LIST, (params) =>
        this.handleList(params as RepoListParams),
      );
    }
  }

  // ── Outbound calls (agent → hub) ────────────────────────────────────────────

  /**
   * Push initial declarations. Typically called once after MAP registration,
   * with the full set of attached workspaces.
   */
  async declare(workspaces: readonly RepoConfig[]): Promise<void> {
    const wire: WorkspaceDeclareInput[] = toWireDeclare(workspaces);
    await this.transport.notify(REPO_METHODS.DECLARE, { workspaces: wire });
  }

  /** Push an incremental diff. */
  async changed(diff: RepoChangedDiff): Promise<void> {
    const params = toWireChanged(diff);
    await this.transport.notify(REPO_METHODS.CHANGED, params);
  }

  /**
   * Retract own bindings. Pass `localPath` to retract one binding for a repo;
   * omit to retract all bindings on the calling agent for that repo.
   */
  async retract(canonicalUrl: string, localPath?: string): Promise<void> {
    const params: { canonical_url: string; local_path?: string } = {
      canonical_url: canonicalUrl,
    };
    if (localPath !== undefined) params.local_path = localPath;
    await this.transport.notify(REPO_METHODS.RETRACT, params);
  }

  // ── Inbound dispatch (hub → agent) ──────────────────────────────────────────

  /**
   * Dispatch a hub-initiated `repo.list` request to the configured `onList`
   * handler. Throws {@link CapabilityError} if no handler was configured —
   * this matches `WorkspaceCapability.list.enabled === false`.
   *
   * Consumers using a transport without `onRequest` should wire this manually:
   *   `transport.setRequestHandler(REPO_METHODS.LIST, (p) => client.handleList(p))`.
   */
  async handleList(params: RepoListParams): Promise<RepoListResult> {
    if (!this.onListHandler) {
      throw new CapabilityError(['workspace.list']);
    }
    return this.onListHandler(params);
  }

  // ── Convenience ─────────────────────────────────────────────────────────────

  /**
   * Snapshot a `RepoManager`'s currently-attached handles into a
   * `RepoConfig[]` suitable for `declare()`.
   *
   * The snapshot is taken at call time; subsequent manager mutations are NOT
   * reflected. For steady-state sync, wire a watcher that emits `changed`
   * diffs as the manager's bindings evolve.
   */
  static snapshot(manager: RepoManager): RepoConfig[] {
    return manager.list().map((handle) => {
      const config: RepoConfig = {
        remoteUrl: handle.identity.canonicalUrl,
        localPath: handle.localPath,
      };
      if (handle.currentBranch !== undefined) config.currentBranch = handle.currentBranch;
      if (handle.headSha !== undefined) config.headSha = handle.headSha;
      if (handle.visibility !== undefined) config.visibility = handle.visibility;
      if (handle.instanceLabel !== undefined) config.instanceLabel = handle.instanceLabel;
      return config;
    });
  }
}
