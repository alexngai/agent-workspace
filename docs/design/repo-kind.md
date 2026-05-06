---
status: draft
owner: alexngai
created: 2026-05-05
revised: 2026-05-05
---

# Repo Kind: Design and Public API

## Scope

This doc covers the **`repo` workspace kind** in detail — the protocol design, the package's public API, the protocol-level lifecycle flows, and the open questions specific to this kind. Background and rationale for adding the kind are in [`architecture.md`](./architecture.md).

Hub-side concerns (persistence, REST, UI, federation materializer, swarm spawn integration) live in the consumer's docs — see openhive's `docs/design/repos-as-syncable-resources.md` for the reference consumer.

The package owns: protocol shapes, canonical URL utility, capability declarations, agent-side client, server-side handler interface. The package does not own: persistence (DAL is hub-side), federation (mesh-sync is hub-side), enforcement of policy layers, REST routes, UI.

---

## What "repo kind" means

A **repo workspace** is the per-agent instance of a codebase: a local clone path, current branch, head SHA, dirty status — bound to a stable canonical identity (the git remote URL). Multiple agents on multiple hubs can have repo workspaces bound to the same canonical identity; the canonical URL is the federation key.

Distinguish two kinds of "thing":

| Concept | Definition | Federates? |
|---|---|---|
| **Repo** | The abstract codebase. Identity = canonical git remote URL. | Yes — canonical URL is the cross-hub key. |
| **Workspace** (per repo) | An agent's local instance: clone path, branch, SHA, dirty. | No — local-only data, would be noise + privacy leak otherwise. |

This distinction matches industry vocabulary (Coder, Gitpod, DevPod, Codespaces all use this split). The package exposes both as types; the consumer/hub decides how each is persisted, federated, or enforced.

---

## Naming conventions

| Surface | Convention | Why |
|---|---|---|
| **Wire types** (JSON-RPC params/results, mesh events, MAP capability fields, YAML manifest references like `repos.config.declare[]`) | `snake_case` | Matches existing `WorkspaceExecuteParams` shape (`request_id`, `local_path`, `head_sha`); JSON-RPC convention; consistent with environment manifests where this kind appears as a layer. |
| **In-memory TS types** (`RepoConfig`, `RepoHandle`, `CanonicalRepoIdentity`, etc.) | `camelCase` | Idiomatic TypeScript. |
| **Constants** (`REPO_METHODS.DECLARE`, `REPO_PROTOCOL_VERSION`) | `SCREAMING_SNAKE` | JS convention. |

The boundary between in-memory and wire shapes is explicit — handler implementations and clients translate at the edge. The package ships translators (`toWireDeclare(input)`, `fromWireDeclare(params)`) so consumers don't reinvent the conversion. When the repo kind appears as a layer inside an environment manifest, the YAML uses the wire (snake_case) shape directly — see [`environment-kind.md`](./environment-kind.md) for examples.

---

## Identity

### Canonical URL

The federation identity is the **normalized git remote URL**. Every comparison, lookup, and merge operation goes through one normalization function so the rule lives in one place.

Canonical form: `https://{host}/{owner}/{repo}` — lowercase, no `.git` suffix, no trailing slash, no query/fragment, port preserved only for self-hosted with non-default.

```typescript
// agent-workspace/kinds/repo/identity.ts

export interface CanonicalRepoIdentity {
  canonicalUrl: string;   // 'https://github.com/acme/foo'
  host: string;           // 'github.com'
  owner: string;          // 'acme'
  name: string;           // 'foo'
}

/** Throws InvalidRepoUrlError on bad input. */
export function canonicalizeRepoUrl(input: string): CanonicalRepoIdentity;

/** Returns null on bad input — for "I have a maybe-URL" cases. */
export function tryCanonicalizeRepoUrl(input: string): CanonicalRepoIdentity | null;

/** Fuzzy match — useful for duplicate detection UIs. */
export function isSimilarRepoUrl(a: string, b: string): boolean;

/** Module-level configuration; call once at process startup. */
export interface RepoIdentityConfig {
  caseSensitiveHosts?: string[];
}
export function setRepoIdentityConfig(config: RepoIdentityConfig): void;
export function getRepoIdentityConfig(): Readonly<RepoIdentityConfig>;
```

**Sync API**, no lazy loading. `git-url-parse` is a regular `dependencies` entry — small, load-bearing, called from many sites; the lazy peer-dep pattern would force every caller to be async.

Module-level config rather than per-call options: a process should canonicalize URLs the same way everywhere; per-call options invite drift between code paths.

Edge cases the test matrix must cover:

| Case | Example |
|---|---|
| SSH ↔ HTTPS | `git@github.com:foo/bar` ≡ `https://github.com/foo/bar` |
| Trailing `.git` | `https://github.com/foo/bar.git` ≡ `https://github.com/foo/bar` |
| Trailing slash | `https://github.com/foo/bar/` ≡ `https://github.com/foo/bar` |
| Query / fragment | `https://github.com/foo/bar?ref=main#L1` → strip |
| `git://` protocol | `git://github.com/foo/bar` → map to `https://...` |
| Port (self-hosted) | `https://gitlab.corp.com:8443/foo/bar` keeps the port |
| Case (GitHub) | `Github.com/Foo/Bar` → `github.com/foo/bar` (case-insensitive) |
| Case (self-hosted opt-in) | host in `caseSensitiveHosts` → preserve owner/name casing |
| Subgroups (GitLab) | `https://gitlab.com/group/subgroup/repo` keeps the path |

### Binding key

A workspace binding's natural key is `(agentId, canonicalUrl, localPath)`. This handles:

| Case | How it resolves |
|---|---|
| Two clones at different paths | Two bindings with same `(agentId, canonicalUrl)`, different `localPath` |
| One clone with `origin` + `upstream` | Two bindings with same `(agentId, localPath)`, different `canonicalUrl` |
| Two worktrees of the same repo at different branches | Two bindings with same `(agentId, canonicalUrl)`, different `localPath`, different `currentBranch` |
| Path rename | Old binding deactivates (path no longer exists); new binding row on next declare |

Optional `instanceLabel` field on the binding for UX disambiguation when several bindings share `(agent, repo)`.

---

## Visibility model

Three tiers, ordered most-restricted → most-open. Identical to GitLab's three-tier shape (`private` / `internal` / `public`).

| Tier | Visible to | Federated? |
|---|---|---|
| `private` | Originating agent (and admin) only | No |
| `hub_local` | All agents/users on the hub | No |
| `federated` | Mesh-wide | Yes |

A fourth, T0 — "agent never declares" — is **not a tier**, it's the absence of declaration. Handled by an agent-side capability flag (`workspace.declare.enabled = false`); the hub never sees the repo at all.

### Two visibilities, not one

The repo has its own visibility; each binding has its own. Both are stored independently.

**Effective visibility for any consumer = `min(repo.visibility, binding.visibility)`.**

So:
- A federated repo with a `private` binding → repo federates, binding stays private (agent can keep its branch/path/dirty private even on a public repo).
- A `hub_local` repo with a `federated` binding → binding clamps to `hub_local` (can't be more public than the parent).

This is symmetric and lets the privacy of "I'm here" be decoupled from the privacy of "this repo exists."

### Authority — who can up/downgrade what

Asymmetric: opening requires consent from the most-restrictive party; closing is unilateral by higher-authority parties.

| Field | Owner (can ↑) | Can ↓ |
|---|---|---|
| `repo.visibility` | Repo creator (user or originator agent) | Owner OR hub admin |
| `binding.visibility` | The binding's agent | Agent OR hub admin |

Hub admins always have both directions for compliance scenarios. The protocol does not enforce these — the consumer/hub is responsible for the authority check before persisting changes. The package exposes the field shapes and the merge rule.

### Federated downgrade — the redaction primitive

Going from `federated` → `hub_local` (or `private`) on a repo that has already federated:

```
T3 → T2 on origin hub
  → emit mesh event:    resource.redacted { canonical_url, new_visibility }
  → peer hubs: tombstone the resource (mark redacted_remote, keep canonical_url row)
              remove from cross-mesh queries
              local bindings on peer hubs unaffected (bindings are local; their existence is unchanged)
```

**Limitations** (mirror ActivityPub's stance — be explicit in docs):

- Best-effort, not cryptographic. A peer that never reconnects keeps the cached copy.
- Tombstones leak existence (peers know the URL existed, just not current metadata).
- For hard privacy, never federate in the first place.

The protocol exposes the redaction event shape; the consumer/hub implements both the emit and the tombstone logic.

---

## Wire protocol

### Versioning

```typescript
// agent-workspace/protocol/repo.ts
export const REPO_PROTOCOL_VERSION = '1' as const;
```

Hubs and agents advertise compatibility via the capability declaration (`workspace.protocolVersion`); cross-major-version interop is rejected at handshake.

### Method namespace

```
x-workspace/repo.declare       # agent → hub, push initial set or additions
x-workspace/repo.changed       # agent → hub, diff events {added, removed}
x-workspace/repo.list          # hub → agent, pull current set (reconciliation)
x-workspace/repo.retract       # agent → hub, downgrade own bindings
```

The four methods together cover:

- **Declare** — initial registration. Idempotent; calling twice with the same canonical_url just re-upserts.
- **Changed** — incremental diffs in LSP `didChangeWorkspaceFolders` style. Less wire traffic than full-state replacement and unambiguous about partials.
- **List** — pull recovery. Hub asks agent for its current set; used after hub restart, federation lag, or explicit refresh.
- **Retract** — agent-initiated visibility downgrade for its own bindings.

Optionally, agent declarations can ride along on the MAP `agent.registered` payload to avoid a one-RTT race after handshake (LSP `InitializeParams.workspaceFolders` pattern).

### Method types (wire — snake_case)

```typescript
// agent-workspace/protocol/repo.ts

export const REPO_METHODS = {
  DECLARE: 'x-workspace/repo.declare',
  CHANGED: 'x-workspace/repo.changed',
  LIST:    'x-workspace/repo.list',
  RETRACT: 'x-workspace/repo.retract',
} as const;

export type RepoVisibility = 'private' | 'hub_local' | 'federated';

export interface WorkspaceDeclareInput {
  remote_url: string;            // raw — hub canonicalizes
  local_path: string;
  current_branch?: string;
  head_sha?: string;
  dirty?: boolean;
  visibility?: RepoVisibility;
  instance_label?: string;
}

export interface RepoDeclareParams {
  workspaces: WorkspaceDeclareInput[];
}

export interface RepoChangedParams {
  added?: WorkspaceDeclareInput[];
  removed?: Array<{ canonical_url: string; local_path: string }>;
}

export interface RepoListParams {
  /** Optional filter; default returns all visible bindings. */
  filter?: { canonical_url?: string };
}

export interface RepoListResult {
  workspaces: WorkspaceDeclareInput[];
}

export interface RepoRetractParams {
  canonical_url: string;
  local_path?: string;           // omit to retract all bindings for this repo
}
```

### Mesh-level events (shared across resource types)

These live in `agent-workspace/protocol/resource-events.ts`, not in `repo.ts`, because the same event shapes apply to other federated resources (memory_banks, sessions, future kinds).

```typescript
// agent-workspace/protocol/resource-events.ts

export const RESOURCE_MESH_EVENTS = {
  REDACTED: 'resource.redacted',
  ARCHIVED: 'resource.archived',
  MERGED:   'resource.merged',
} as const;

export interface ResourceRedactedEvent {
  resource_type: string;          // 'repo' | 'memory_bank' | ...
  canonical_url: string;
  new_visibility: string;         // values are per resource type
  redacted_at: string;
  origin_hub_id: string;
}

export interface ResourceArchivedEvent {
  resource_type: string;
  canonical_url: string;
  archived_at: string;
  origin_hub_id: string;
}

export interface ResourceMergedEvent {
  resource_type: string;
  source_canonical_url: string;
  target_canonical_url: string;
  merged_at: string;
  origin_hub_id: string;
}
```

`protocol/repo.ts` re-exports these for convenience but doesn't own them.

### Federation merge race resolution

Conflicting merges from two hubs apply in deterministic order: lexicographic `(origin_hub_id, merged_at)`. Tombstone pointers always terminate because merges are write-once. The "loser" merge becomes a no-op locally because the target is already a tombstone; the merge chain follows tombstone redirects to the final survivor.

The package exposes the rule as a comparator so consumers sort their own arrays — no array argument shape forced on the caller:

```typescript
// agent-workspace/protocol/resource-events.ts
export function compareMergeEvents(
  a: ResourceMergedEvent,
  b: ResourceMergedEvent,
): -1 | 0 | 1;
```

---

## Capability extension

Per-agent `ParticipantCapabilities` gain a `workspace` field. Per-method shape so future methods can declare independently without breaking existing fields:

```typescript
// agent-workspace/protocol/repo.ts

export interface WorkspaceCapability {
  protocolVersion: string;        // matches REPO_PROTOCOL_VERSION major

  declare: {
    enabled: boolean;             // master switch — false = hub never sees this agent's repos
    defaultVisibility: RepoVisibility;
    /** Hard cap: agent will never declare above this visibility, even if asked. */
    maxVisibility?: RepoVisibility;
  };

  list: {
    enabled: boolean;             // whether agent answers x-workspace/repo.list pulls
  };

  // Future-proofed: changed/retract are derived from declare.enabled in v1;
  // promoted to first-class fields if independent control becomes useful.
}
```

This is what gets advertised in MAP at registration. Capability fields use camelCase (matches MAP convention for capability declarations); the wire format under MAP is itself the JSON shape.

Privacy escape hatch: `declare.enabled: false` means the agent simply does not call `x-workspace/repo.*`. The trajectory-handler bootstrap (which infers repos from checkpoint metadata) must respect this flag — if `declare.enabled === false`, the trajectory-side inference is also skipped.

---

## Public API

### `RepoIdentity` (canonical URL utility)

Already covered above.

### `RepoConfig` and `RepoHandle`

Following the package's config-vs-handle split (cf. `SandboxConfig` / `SandboxHandle`). In-memory types use camelCase:

```typescript
// agent-workspace/kinds/repo/types.ts

export interface RepoConfig {
  /** Raw or canonical URL. The manager canonicalizes internally. */
  remoteUrl: string;
  localPath: string;
  currentBranch?: string;
  headSha?: string;
  visibility?: RepoVisibility;
  instanceLabel?: string;
}

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

  /** Re-read git state and return fresh values without mutating the snapshot. */
  inspectGit(): Promise<{
    currentBranch: string | undefined;
    headSha: string | undefined;
    dirty: boolean;
  }>;

  /** Update visibility (downgrades only — upgrades require external authority). */
  retract(toVisibility: RepoVisibility): Promise<void>;

  /** Section accessor inherited from base WorkspaceHandle. */
  dir(section: string): string;
}
```

`refresh()` mutates the handle (use when the caller wants the snapshot updated for everyone). `inspectGit()` returns fresh state without mutating (use for one-shot checks where mutating shared state would surprise other readers).

### `RepoManager`

Lifecycle is `attach` / `detach`, not `create` / `cleanup` (since repo workspaces are persistent, not ephemeral).

```typescript
// agent-workspace/kinds/repo/manager.ts

export interface RepoManagerConfig {
  /** Optional metadata storage location. Defaults to ${localPath}/.workspace.json. */
  metaPath?: (config: RepoConfig) => string;
  /** Run git inspection on attach to populate currentBranch/headSha/dirty. Default: true. */
  inspectGitOnAttach?: boolean;
}

export class RepoManager {
  constructor(config?: RepoManagerConfig);

  /**
   * Attach to an existing local clone. The remoteUrl can be raw — the manager
   * canonicalizes it. If a binding already exists for this (canonicalUrl, localPath),
   * the existing handle is returned with its snapshot fields and metadata replaced
   * by the new RepoConfig.
   */
  attach(config: RepoConfig): Promise<RepoHandle>;

  /** Detach from a clone. Does NOT delete the clone — only releases the handle. */
  detach(handle: RepoHandle): Promise<void>;

  /** List all currently-attached repo handles. */
  list(): RepoHandle[];

  /** Find an attached handle by canonical URL + local path. */
  find(canonicalUrl: string, localPath: string): RepoHandle | undefined;
}
```

`attach()` is idempotent. Second call's metadata replaces the first's — most consumers calling twice are doing it because state changed. `detach()` is non-destructive. The manager holds in-memory state only; consumers re-attach on process restart.

### Agent-side client (`RepoClient`)

For agents to talk to a hub. Wraps the four `x-workspace/repo.*` methods as ergonomic calls.

```typescript
// agent-workspace/kinds/repo/client.ts

export interface RepoClientTransport {
  notify(method: string, params: unknown): Promise<void>;
  request<T>(method: string, params: unknown): Promise<T>;
}

export interface RepoClientOptions {
  /** Handler for hub-initiated x-workspace/repo.list pulls. */
  onList?: (params: RepoListParams) => Promise<RepoListResult>;
}

export class RepoClient {
  constructor(transport: RepoClientTransport, options?: RepoClientOptions);

  /** Push an initial declare. Typically called once after MAP registration. */
  declare(workspaces: RepoConfig[]): Promise<void>;

  /** Push an incremental diff. */
  changed(diff: { added?: RepoConfig[]; removed?: Array<{ canonicalUrl: string; localPath: string }> }): Promise<void>;

  /** Retract own bindings. */
  retract(canonicalUrl: string, localPath?: string): Promise<void>;

  /**
   * Convenience: snapshot a manager's attached handles for declare().
   * Returns RepoConfig[]. Caller is responsible for race windows between
   * snapshot and declare — for steady-state sync, wire a watcher pattern.
   */
  static snapshot(manager: RepoManager): RepoConfig[];
}
```

`onList` is supplied at construction (no mutator setter) — keeps the client immutable after construction. Methods accept in-memory `RepoConfig[]` and translate to wire format internally. Agents typically use this with a `RepoManager`:

```typescript
const manager = new RepoManager();
await manager.attach({ remoteUrl: 'https://github.com/acme/foo', localPath: '~/code/foo' });
await manager.attach({ remoteUrl: 'https://github.com/acme/bar', localPath: '~/code/bar' });

const client = new RepoClient(mapTransport, {
  onList: async () => ({ workspaces: toWireDeclare(RepoClient.snapshot(manager)) }),
});

await client.declare(RepoClient.snapshot(manager));
```

### Server-side handler interface (`RepoProtocolHandler`)

For hubs to plug persistence/auth/policy into. The package defines the interface; hubs implement it.

```typescript
// agent-workspace/kinds/repo/server.ts

export interface RepoHandlerContext {
  /** Required. Hubs must populate from authenticated session. */
  agentId: string;
  /** Required. Hubs must populate from connection state. */
  swarmId: string;
  capabilities?: WorkspaceCapability;
}

export interface RepoProtocolHandler {
  onDeclare(params: RepoDeclareParams, ctx: RepoHandlerContext): Promise<void>;
  onChanged(params: RepoChangedParams, ctx: RepoHandlerContext): Promise<void>;
  onList(params: RepoListParams, ctx: RepoHandlerContext): Promise<RepoListResult>;
  onRetract(params: RepoRetractParams, ctx: RepoHandlerContext): Promise<void>;
}

/** Helper: register the four method handlers on a JSON-RPC server. */
export function registerRepoHandlers(
  server: { addHandler(name: string, fn: (params: unknown, ctx: unknown) => Promise<unknown>): void },
  handler: RepoProtocolHandler,
): { unregister(): void };
```

`registerRepoHandlers` returns an unregister handle so consumers can unwire (test teardown, hot reload, transport swap).

**Disconnect handling is out-of-band.** The protocol doesn't include an `onDisconnect` method — disconnection is a hub-internal lifecycle event, not a protocol method. Hubs deactivate bindings when their transport reports a connection close; the package doesn't observe this directly. A recipe lives in [`architecture.md`](./architecture.md#flow-d---disconnect--cleanup).

### Wire ↔ in-memory translators

Explicit converters at the boundary between snake_case wire types and camelCase in-memory types:

```typescript
// agent-workspace/kinds/repo/wire.ts
export function toWireDeclare(input: RepoConfig[]): WorkspaceDeclareInput[];
export function fromWireDeclare(params: WorkspaceDeclareInput[]): RepoConfig[];
export function toWireChanged(input: { added?: RepoConfig[]; removed?: Array<{ canonicalUrl: string; localPath: string }> }): RepoChangedParams;
export function fromWireChanged(params: RepoChangedParams): { added?: RepoConfig[]; removed?: Array<{ canonicalUrl: string; localPath: string }> };
```

`RepoClient` and the recommended `RepoProtocolHandler` adapter use these so consumers don't reimplement the conversion.

### Policy hooks

```typescript
// agent-workspace/kinds/repo/policy.ts

/** min(repo, binding) — the effective visibility for any consumer. */
export function effectiveVisibility(
  repo: RepoVisibility,
  binding: RepoVisibility,
): RepoVisibility;

/** True if `to` is more restricted than `from`. */
export function isVisibilityDowngrade(from: RepoVisibility, to: RepoVisibility): boolean;

/** True if `to` is more open than `from`. */
export function isVisibilityUpgrade(from: RepoVisibility, to: RepoVisibility): boolean;
```

The "do you have authority for this transition" question is a hub concern, not a pure function over visibility values — it's not exposed by the package.

---

## Errors

A small hierarchy. Hubs translate to JSON-RPC error codes; consumers can pattern-match on `code`.

```typescript
// agent-workspace/kinds/repo/errors.ts

export abstract class RepoError extends Error {
  abstract readonly code: string;
}

export class InvalidRepoUrlError extends RepoError {
  readonly code = 'invalid_url';
  constructor(public readonly input: string, public readonly reason: string);
}

export class PolicyViolationError extends RepoError {
  readonly code = 'policy_violation';
  constructor(
    public readonly layer: 'hub' | 'repo' | 'swarm' | 'agent',
    public readonly detail: string,
  );
}

export class CapabilityError extends RepoError {
  readonly code = 'capability';
  constructor(public readonly missing: string[]);
}

export class NotAttachedError extends RepoError {
  readonly code = 'not_attached';
  constructor(public readonly canonicalUrl: string, public readonly localPath: string);
}
```

`canonicalizeRepoUrl` throws `InvalidRepoUrlError`. `RepoProtocolHandler` implementations are expected to throw `PolicyViolationError` (translated to JSON-RPC -32004 `policy_violation` by hub adapters). `RepoManager.detach` on an unknown handle throws `NotAttachedError`.

---

## Testing utilities (`agent-workspace/kinds/repo/testing`)

Ships in a separate subpath so production builds don't pull it in:

```typescript
import { InMemoryRepoHandler, MockRepoTransport } from 'agent-workspace/kinds/repo/testing';
```

### `InMemoryRepoHandler`

A working `RepoProtocolHandler` implementation backed by `Map`. Useful for integration tests, single-process demos, and the v0.4 reference impl while we wait for hub-side wiring. It enforces the visibility tier rules (effective visibility, downgrade-only retract) and the canonical URL deduping; it does not enforce hub/swarm/repo policy layers (those are the consumer's domain).

```typescript
const hub = new InMemoryRepoHandler();
await hub.onDeclare({ workspaces: [...] }, { agentId: 'a1', swarmId: 's1' });
const list = await hub.onList({}, { agentId: 'a1', swarmId: 's1' });
```

### `MockRepoTransport`

Fake JSON-RPC transport that records calls and lets tests assert wire format:

```typescript
const transport = new MockRepoTransport();
const client = new RepoClient(transport);
await client.declare([{ remoteUrl: 'https://github.com/acme/foo', localPath: '/tmp/foo' }]);

expect(transport.calls).toEqual([
  { method: 'x-workspace/repo.declare', params: { workspaces: [{ remote_url: '...', local_path: '...' }] } },
]);
```

These two together let consumers test the end-to-end loop without a real MAP server.

---

## Lifecycle flows

These are the **protocol-level** flows — what wire messages flow when. Consumer-side flows (federation across hubs, REST endpoints, UI affordances) live in the consumer's docs.

### Declare flow

```
Agent boot:
  manager.attach(config1)   → reads git state on disk (inspectGitOnAttach: true default)
  manager.attach(config2)
  client.declare(RepoClient.snapshot(manager))
    → x-workspace/repo.declare { workspaces: [w1, w2] (wire format) }
    → hub's RepoProtocolHandler.onDeclare:
        for each workspace:
          identity = canonicalizeRepoUrl(remote_url)
          [hub policy enforcement — may throw PolicyViolationError]
          [hub upserts repo + binding]
          [hub broadcasts on its realtime channel]
```

### Changed flow (incremental diff)

```
Agent observes git state change (commit, branch switch, dirty flag flip):
  manager.find(canonicalUrl, localPath).refresh()
  client.changed({
    added: [...new bindings...],
    removed: [...departed bindings...],
  })
    → x-workspace/repo.changed
    → handler.onChanged:
        added: same as declare path
        removed: deactivate matching bindings
```

For an agent that simply moves between branches on the same binding, no `changed` is needed — the next `refresh()` updates the snapshot, and a subsequent `declare` (or `list` response) carries the new branch. `changed` is for *set membership* changes only.

### List flow (hub pull for reconciliation)

```
Hub restart, or explicit refresh:
  hub sends x-workspace/repo.list { filter? } as a request
  agent's RepoClient invokes the configured onList handler:
    return { workspaces: toWireDeclare(RepoClient.snapshot(manager)) }
  agent responds with current set
  hub reconciles: declares/removes to match agent's authoritative view
```

Push (`declare`/`changed`) is the steady state; `list` is the recovery path. Both must converge to the same hub-side state given the same agent state.

### Retract flow (agent-initiated downgrade)

```
Agent decides to make a binding private:
  client.retract(canonicalUrl, localPath?)
    → x-workspace/repo.retract
    → handler.onRetract:
        clamp matching binding(s) to visibility='private'
        if retracting all bindings on a federated repo, hub may consider tombstone
        (consumer-side decision)
```

Retract is not the same as remove. The binding stays; only its visibility narrows. To remove, use `changed.removed`.

---

## Threat model and limits

What the protocol-level design *does*:

- Provides a canonical, federation-friendly identity for codebases.
- Provides explicit visibility tiers and a clear effective-visibility rule.
- Provides the redaction primitive for downgrading already-federated repos.
- Provides an opt-out switch (`declare.enabled: false` plus `maxVisibility`) that holds across both explicit declares and trajectory-inferred declarations.
- Provides the merge primitive and deterministic ordering for race resolution.

What the protocol-level design **does not** do:

- **Cryptographically enforce redaction.** Mirrors ActivityPub. A peer that never reconnects keeps the cached copy. Document this limit prominently.
- **Prove identity.** Anyone can declare any canonical URL. Authentication is layered above (agent-iam attestation, hub auth). The protocol assumes the caller is who they say they are.
- **Validate that the local clone actually matches the canonical URL.** An agent could declare `remoteUrl: github.com/acme/foo` while pointing `localPath` at an unrelated repo. Detecting this requires git inspection (`RepoManager.attach` does it on attach by default); the protocol itself does not enforce.
- **Handle non-git workspaces.** Required identity is a git remote URL. Sandboxes, docs dirs, non-git folders are out of scope; if a real use case appears, add a separate workspace kind.

---

## Open questions

1. **`git-url-parse` library coverage.** Known gaps (subgroups, casing, fuzzy matching). Lean: ship with the lib + our own normalization wrapper; fork only if maintenance becomes painful.
2. **Should `RepoManager` watch the filesystem for git state changes?** Auto-emit `changed` events when HEAD moves. Lean: optional and off by default — consumers can wire their own watcher; built-in watcher invites cross-OS compat issues.
3. **What about archived repos?** A peer hub may have a binding to a repo that's been archived elsewhere. Does the binding stay live? Lean: yes — archive is hub-side metadata, doesn't affect remote bindings. Consumer decides UI treatment.
4. **Multi-remote per local clone.** An agent has one clone with `origin` and `upstream` remotes — declares once with origin, or twice with both? Lean: protocol supports both, agent's choice. Two declares = two bindings sharing `localPath`, different `canonicalUrl`.
5. **Branch tracking granularity.** Track every branch the agent visits, or only the current one? Lean: only current branch in the binding row; branch history (if needed) is repo-level metadata that hubs can opt to track from `changed` events.
6. **`maxVisibility` interaction with hub upgrades.** If a user-defined repo's visibility upgrades from `hub_local` → `federated`, an agent with `maxVisibility: hub_local` keeps its binding clamped — but the *repo* is now federated. Effective visibility for federated peers becomes `min(federated, hub_local) = hub_local`, so peers don't see this binding. Confirm this is the desired behavior. (Lean: yes — `maxVisibility` is the agent's privacy ceiling, applied independently of repo state.)
7. **Translator code generation.** `toWireDeclare` / `fromWireDeclare` are mechanical. Hand-write or codegen? Lean: hand-write — types are small enough; codegen adds tooling.
8. **Should `RepoIdentityConfig` be process-global or per-RepoManager?** Today proposed as process-global via `setRepoIdentityConfig`. If multiple managers in one process need different rules, this breaks. Lean: keep process-global for v0.4; revisit only if a real use case appears.

---

## Cross-references

- [`architecture.md`](./architecture.md) — overall package architecture and direction.
- OpenHive `docs/design/repos-as-syncable-resources.md` — reference consumer; covers persistence (DAL, schema), federation (mesh-sync materializer), REST routes, UI, swarm spawn integration, trajectory bootstrap, and openhive-specific policy layers.
