/**
 * Testing utilities for the repo kind.
 *
 * Two helpers ship under the `agent-workspace/kinds/repo/testing` subpath
 * so production builds can avoid pulling them in:
 *
 * - {@link InMemoryRepoHandler} — a working `RepoProtocolHandler` impl
 *   backed by `Map`. Useful for integration tests, single-process demos,
 *   and a v0.4 reference for hub authors. Enforces canonical-URL deduping
 *   and the basic visibility filter (`private` bindings only visible to
 *   the originating agent). Does NOT enforce hub/swarm/repo policy layers
 *   — those are consumer-side concerns.
 *
 * - {@link MockRepoTransport} — a fake `RepoClientTransport` that records
 *   `notify`/`request` calls, lets tests assert wire format, and supports
 *   simulating hub-initiated requests via `simulateInbound`.
 */

import { canonicalizeRepoUrl } from '../../lib/canonical-url.js';
import type {
  RepoDeclareParams,
  RepoChangedParams,
  RepoListParams,
  RepoListResult,
  RepoRetractParams,
  RepoVisibility,
  WorkspaceDeclareInput,
} from '../../protocol/repo.js';
import type {
  RepoProtocolHandler,
  RepoHandlerContext,
} from './server.js';
import type { RepoClientTransport } from './client.js';

// ──────────────────────────────────────────────────────────────────────────────
// InMemoryRepoHandler
// ──────────────────────────────────────────────────────────────────────────────

/** Snapshot of a binding stored by {@link InMemoryRepoHandler}. */
export interface InMemoryBinding {
  agentId: string;
  swarmId: string;
  canonicalUrl: string;
  localPath: string;
  currentBranch: string | undefined;
  headSha: string | undefined;
  dirty: boolean;
  visibility: RepoVisibility;
  instanceLabel: string | undefined;
}

/** Snapshot of a repo resource stored by {@link InMemoryRepoHandler}. */
export interface InMemoryRepo {
  canonicalUrl: string;
  visibility: RepoVisibility;
}

/**
 * In-memory `RepoProtocolHandler` for tests and demos. State is held in two
 * `Map`s; nothing is persisted.
 *
 * Visibility filter on `onList`: a `private` binding is only returned when
 * the calling agent is its owner. Hub/swarm/repo policy layers (multi-tenant
 * enforcement) are NOT applied — this is a test harness, not production.
 */
export class InMemoryRepoHandler implements RepoProtocolHandler {
  /** Repos keyed by canonical URL. */
  private readonly repos: Map<string, InMemoryRepo> = new Map();
  /** Bindings keyed by `(agentId, canonicalUrl, localPath)`. */
  private readonly bindings: Map<string, InMemoryBinding> = new Map();

  async onDeclare(params: RepoDeclareParams, ctx: RepoHandlerContext): Promise<void> {
    for (const w of params.workspaces) {
      const identity = canonicalizeRepoUrl(w.remote_url);
      const visibility: RepoVisibility = w.visibility ?? 'hub_local';

      // Upsert repo by canonical URL.
      if (!this.repos.has(identity.canonicalUrl)) {
        this.repos.set(identity.canonicalUrl, {
          canonicalUrl: identity.canonicalUrl,
          visibility,
        });
      }

      // Upsert binding (idempotent on the per-agent triple).
      const key = bindingKey(ctx.agentId, identity.canonicalUrl, w.local_path);
      this.bindings.set(key, {
        agentId: ctx.agentId,
        swarmId: ctx.swarmId,
        canonicalUrl: identity.canonicalUrl,
        localPath: w.local_path,
        currentBranch: w.current_branch,
        headSha: w.head_sha,
        dirty: w.dirty ?? false,
        visibility,
        instanceLabel: w.instance_label,
      });
    }
  }

  async onChanged(params: RepoChangedParams, ctx: RepoHandlerContext): Promise<void> {
    if (params.added && params.added.length > 0) {
      await this.onDeclare({ workspaces: params.added }, ctx);
    }
    if (params.removed && params.removed.length > 0) {
      for (const r of params.removed) {
        const key = bindingKey(ctx.agentId, r.canonical_url, r.local_path);
        this.bindings.delete(key);
      }
    }
  }

  async onList(params: RepoListParams, ctx: RepoHandlerContext): Promise<RepoListResult> {
    const filterUrl = params.filter?.canonical_url;
    const workspaces: WorkspaceDeclareInput[] = [];

    for (const binding of this.bindings.values()) {
      if (filterUrl && binding.canonicalUrl !== filterUrl) continue;
      // Visibility filter: `private` bindings visible only to their owner.
      if (binding.visibility === 'private' && binding.agentId !== ctx.agentId) continue;

      workspaces.push(bindingToWire(binding));
    }

    return { workspaces };
  }

  async onRetract(params: RepoRetractParams, ctx: RepoHandlerContext): Promise<void> {
    // Retract always narrows visibility to `private`. Already-private bindings
    // are no-ops; never an upgrade, so no PolicyViolationError is reachable here.
    const target: RepoVisibility = 'private';

    if (params.local_path !== undefined) {
      // Single binding.
      const key = bindingKey(ctx.agentId, params.canonical_url, params.local_path);
      const binding = this.bindings.get(key);
      if (binding) binding.visibility = target;
      return;
    }

    // All bindings on the calling agent for this canonical URL.
    for (const binding of this.bindings.values()) {
      if (binding.agentId === ctx.agentId && binding.canonicalUrl === params.canonical_url) {
        binding.visibility = target;
      }
    }
  }

  // ── Inspection helpers (test introspection) ────────────────────────────────

  /** All bindings currently stored. */
  listBindings(): InMemoryBinding[] {
    return Array.from(this.bindings.values());
  }

  /** All repos currently stored. */
  listRepos(): InMemoryRepo[] {
    return Array.from(this.repos.values());
  }

  /** Reset state (e.g. between tests). */
  reset(): void {
    this.repos.clear();
    this.bindings.clear();
  }
}

function bindingKey(agentId: string, canonicalUrl: string, localPath: string): string {
  return `${agentId}\x00${canonicalUrl}\x00${localPath}`;
}

function bindingToWire(b: InMemoryBinding): WorkspaceDeclareInput {
  const out: WorkspaceDeclareInput = {
    remote_url: b.canonicalUrl,
    local_path: b.localPath,
    dirty: b.dirty,
    visibility: b.visibility,
  };
  if (b.currentBranch !== undefined) out.current_branch = b.currentBranch;
  if (b.headSha !== undefined) out.head_sha = b.headSha;
  if (b.instanceLabel !== undefined) out.instance_label = b.instanceLabel;
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// MockRepoTransport
// ──────────────────────────────────────────────────────────────────────────────

/** A `notify` or `request` call recorded by {@link MockRepoTransport}. */
export interface RecordedCall {
  method: string;
  params: unknown;
}

/**
 * Fake JSON-RPC transport for client-side tests.
 *
 * Records every `notify` and `request` call. Supplies canned responses for
 * `request` via {@link MockRepoTransport.requestResponses}. Captures handlers
 * installed via `onRequest`; tests can fire those handlers via
 * {@link MockRepoTransport.simulateInbound} to mimic hub-initiated requests.
 */
export class MockRepoTransport implements RepoClientTransport {
  /** All `notify()` calls in order. */
  notifies: RecordedCall[] = [];
  /** All `request()` calls in order. */
  requests: RecordedCall[] = [];
  /** Canned responses by method name. */
  requestResponses: Map<string, unknown> = new Map();
  /** Handlers installed by the client via `onRequest`. */
  installedHandlers: Map<string, (params: unknown) => Promise<unknown>> = new Map();

  async notify(method: string, params: unknown): Promise<void> {
    this.notifies.push({ method, params });
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    return this.requestResponses.get(method) as T;
  }

  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.installedHandlers.set(method, handler);
  }

  /**
   * Simulate the hub sending an inbound request. Throws if no handler is
   * installed for the method (helpful for catching wiring mistakes early).
   */
  async simulateInbound(method: string, params: unknown): Promise<unknown> {
    const handler = this.installedHandlers.get(method);
    if (!handler) {
      throw new Error(
        `MockRepoTransport: no handler installed for method "${method}". ` +
        `Did the client construct with the matching option (e.g. onList)?`,
      );
    }
    return handler(params);
  }

  /** Clear all recorded calls and installed handlers. */
  reset(): void {
    this.notifies = [];
    this.requests = [];
    this.requestResponses.clear();
    this.installedHandlers.clear();
  }
}
