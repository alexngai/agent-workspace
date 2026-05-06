/**
 * Server-side handler interface for the repo kind.
 *
 * The package defines the protocol contract; hubs (openhive, etc.) implement
 * `RepoProtocolHandler` and call `registerRepoHandlers(server, handler)` to
 * wire the four `x-workspace/repo.*` methods onto their JSON-RPC server.
 *
 * The package itself is hub-agnostic: it doesn't know about persistence,
 * federation, REST, UI, or per-hub policy layers. Those are consumer concerns.
 *
 * See `docs/design/repo-kind.md` "Server-side handler interface" section.
 */

import {
  REPO_METHODS,
  type RepoDeclareParams,
  type RepoChangedParams,
  type RepoListParams,
  type RepoListResult,
  type RepoRetractParams,
  type WorkspaceCapability,
} from '../../protocol/repo.js';

// ── Handler context ───────────────────────────────────────────────────────────

/**
 * Context the hub MUST populate from authenticated session + connection state
 * before invoking a handler. The package does not extract these — it's the
 * transport adapter's job.
 */
export interface RepoHandlerContext {
  /** Required. Hubs must populate from authenticated session. */
  agentId: string;
  /** Required. Hubs must populate from connection state. */
  swarmId: string;
  /** Optional: capabilities the agent advertised at registration. */
  capabilities?: WorkspaceCapability;
}

// ── Handler interface (consumer implements) ───────────────────────────────────

/**
 * Hub-side handler implementation. Consumers (openhive, other hubs) implement
 * this once and pass it to `registerRepoHandlers`.
 *
 * Methods own persistence, federation, and per-hub policy enforcement. The
 * package does not implement any of these — it only owns the wire format
 * and method dispatch.
 */
export interface RepoProtocolHandler {
  onDeclare(params: RepoDeclareParams, ctx: RepoHandlerContext): Promise<void>;
  onChanged(params: RepoChangedParams, ctx: RepoHandlerContext): Promise<void>;
  onList(params: RepoListParams, ctx: RepoHandlerContext): Promise<RepoListResult>;
  onRetract(params: RepoRetractParams, ctx: RepoHandlerContext): Promise<void>;
}

// ── Server contract ───────────────────────────────────────────────────────────

/**
 * Minimal JSON-RPC server shape required by `registerRepoHandlers`.
 *
 * `removeHandler` is optional: when supplied, `unregister()` cleanly tears
 * down. When absent, `unregister()` is a no-op (logged at the consumer layer
 * if they need to know).
 */
export interface RepoMethodServer {
  addHandler(
    method: string,
    fn: (params: unknown, ctx: unknown) => Promise<unknown>,
  ): void;
  removeHandler?(method: string): void;
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Wire the four `x-workspace/repo.*` methods on the supplied server,
 * delegating to the consumer's `RepoProtocolHandler` impl.
 *
 * Returns an `unregister()` function; if the server's `removeHandler` is not
 * supplied, `unregister()` is a no-op. Consumers that need clean teardown
 * (test fixtures, hot reload) should supply a server with `removeHandler`.
 */
export function registerRepoHandlers(
  server: RepoMethodServer,
  handler: RepoProtocolHandler,
): { unregister(): void } {
  // Each entry: [method name, dispatch fn]. The dispatch fn casts `unknown`
  // params + ctx to the typed shapes — we trust the transport adapter to
  // populate ctx correctly per `RepoHandlerContext`.
  const entries: Array<readonly [string, (p: unknown, c: unknown) => Promise<unknown>]> = [
    [
      REPO_METHODS.DECLARE,
      (p, c) => handler.onDeclare(p as RepoDeclareParams, c as RepoHandlerContext),
    ],
    [
      REPO_METHODS.CHANGED,
      (p, c) => handler.onChanged(p as RepoChangedParams, c as RepoHandlerContext),
    ],
    [
      REPO_METHODS.LIST,
      (p, c) => handler.onList(p as RepoListParams, c as RepoHandlerContext),
    ],
    [
      REPO_METHODS.RETRACT,
      async (p, c) => {
        await handler.onRetract(p as RepoRetractParams, c as RepoHandlerContext);
      },
    ],
  ];

  for (const [method, fn] of entries) {
    server.addHandler(method, fn);
  }

  return {
    unregister(): void {
      if (typeof server.removeHandler !== 'function') return;
      for (const [method] of entries) {
        server.removeHandler(method);
      }
    },
  };
}
