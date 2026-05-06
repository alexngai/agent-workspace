---
status: draft
owner: alexngai
created: 2026-05-06
revised: 2026-05-06
---

# Agent Integration Recipe — sidecar wire-up for `kinds/repo`

## Scope

This is the minimal integration recipe for adding `kinds/repo` support to an
agent sidecar (cc-swarm, macro-agent, or similar) that connects to a hub
implementing the `RepoProtocolHandler` interface.

The recipe assumes:
- The sidecar already speaks MAP and has a connection object with
  `notify(method, params)` and `request(method, params)` methods (or the
  agent-side equivalent of a JSON-RPC client).
- The hub (e.g. openhive) registers handlers for the four `x-workspace/repo.*`
  methods. See openhive's `docs/design/repos-as-syncable-resources.md` for
  the consumer-side wire-up.

For the protocol design and full API, see [`repo-kind.md`](./repo-kind.md).

---

## What "agent-side integration" entails

Three pieces, in order of impact:

1. **Capability declaration** — advertise `WorkspaceCapability` at MAP
   registration so the hub knows the agent can declare workspaces. Cheapest;
   one-line change inside an existing `capabilities` object.
2. **Initial declare** — after a successful connection, build a `RepoClient`
   and call `client.declare(...)` with the agent's known repos.
3. **Diff updates** — emit `client.changed({ added, removed })` as the
   agent's state evolves (new clones attached, existing ones detached, branch
   switches if you want to track them).

Most agents only need (1) + (2). Diff updates (3) are optional — the hub
falls back to whatever `declare` last said.

---

## Recipe

### 1. Capability declaration

In the sidecar's `connect()` flow, where the existing `capabilities` block
is built (e.g. `messaging`, `mail`, `trajectory`, `tasks`):

```typescript
import {
  REPO_PROTOCOL_VERSION,
  type WorkspaceCapability,
} from 'agent-workspace/kinds/repo';

const workspaceCapability: WorkspaceCapability = {
  protocolVersion: REPO_PROTOCOL_VERSION,
  declare: {
    enabled: process.env.OPENHIVE_WORKSPACE_DECLARE !== 'off',
    defaultVisibility:
      (process.env.OPENHIVE_WORKSPACE_VISIBILITY as
        | 'private' | 'hub_local' | 'federated')
        ?? 'hub_local',
  },
  list: { enabled: true },
};

const connectOpts = {
  // ...existing fields
  capabilities: {
    // ...existing capabilities
    workspace: workspaceCapability,
  },
};
```

The hub stores this on the connection record. OpenHive's
`OpenHiveRepoHandler.onList` already capability-gates against
`ctx.capabilities?.list.enabled` when present.

**Privacy escape hatch:** `OPENHIVE_WORKSPACE_DECLARE=off` disables both the
explicit declare path AND the trajectory-handler bootstrap (cf. design doc
D9). Setting it to `off` means the hub never sees the agent's repos.

### 2. RepoClient construction

After the connection is up, wrap it in a `RepoClient`:

```typescript
import { RepoClient, type RepoClientTransport } from 'agent-workspace/kinds/repo';

// Adapter: shim the MAP connection's API to RepoClientTransport.
// MAP SDK connections typically expose `notify(method, params)` and
// `callExtension(method, params)` — slot whichever applies.
const transport: RepoClientTransport = {
  notify: (method, params) => connection.notify(method, params),
  request: (method, params) => connection.callExtension(method, params),
  // Optional: if the connection supports installing per-method request
  // handlers, RepoClient auto-installs the onList handler. Otherwise the
  // sidecar must wire a manual route from incoming requests to
  // `client.handleList(params)`.
  onRequest: (method, handler) => connection.onRequest?.(method, handler),
};

const client = new RepoClient(transport, {
  // Optional: respond to hub-initiated `x-workspace/repo.list` pulls.
  onList: async () => ({
    workspaces: [], // Populate from the local RepoManager (see below).
  }),
});
```

### 3. Initial declare on startup

Discover the agent's known repos and declare them:

```typescript
import { RepoManager, RepoClient } from 'agent-workspace/kinds/repo';

const manager = new RepoManager();

// Populate from env vars (the simplest path) or filesystem scan.
// Convention: WORKSPACE_REPO_URL + WORKSPACE_LOCAL_PATH for a single repo
// (set by openhive's swarm-spawn flow when spawning hosted swarms with a
// `repo_id`); OPENHIVE_WORKSPACE_REPOS for a JSON list otherwise.
const single = process.env.WORKSPACE_REPO_URL && process.env.WORKSPACE_LOCAL_PATH
  ? [{ remoteUrl: process.env.WORKSPACE_REPO_URL, localPath: process.env.WORKSPACE_LOCAL_PATH }]
  : [];

const multi = process.env.OPENHIVE_WORKSPACE_REPOS
  ? (JSON.parse(process.env.OPENHIVE_WORKSPACE_REPOS) as Array<{ remoteUrl: string; localPath: string }>)
  : [];

for (const cfg of [...single, ...multi]) {
  await manager.attach(cfg);
}

if (workspaceCapability.declare.enabled && manager.list().length > 0) {
  await client.declare(RepoClient.snapshot(manager));
}
```

`manager.attach()` reads git state from disk by default
(`inspectGitOnAttach: true`), so the declared payload includes accurate
`current_branch`, `head_sha`, and `dirty` flags.

### 4. Diff updates (optional)

If the agent's state changes mid-session — e.g. another clone gets attached,
or a binding goes away — call `client.changed`:

```typescript
// New clone attached
const newHandle = await manager.attach({ remoteUrl: '...', localPath: '...' });
await client.changed({
  added: [{
    remoteUrl: newHandle.identity.canonicalUrl,
    localPath: newHandle.localPath,
    currentBranch: newHandle.currentBranch,
  }],
});

// Binding removed
await manager.detach(handle);
await client.changed({
  removed: [{
    canonicalUrl: handle.identity.canonicalUrl,
    localPath: handle.localPath,
  }],
});
```

Branch / HEAD / dirty changes mid-session do NOT require `changed` events —
they're per-binding runtime state. If the hub needs fresh state, it issues a
`x-workspace/repo.list` request which the agent's `onList` answers from the
manager's current snapshot.

### 5. Filesystem-watcher pattern (advanced)

For long-running agents whose repo state evolves frequently, a watcher loop
that periodically calls `manager.list().forEach(h => h.refresh())` and emits
`client.changed` diffs is the natural extension. v0.4 doesn't ship a built-in
watcher — see `repo-kind.md` open question Q2.

---

## Recipe summary

```typescript
// 1. Declare capability at registration
const workspaceCapability: WorkspaceCapability = { ... };

// 2. Build RepoClient from MAP transport
const client = new RepoClient(transport, { onList });

// 3. Discover repos + attach
const manager = new RepoManager();
await manager.attach({ remoteUrl, localPath });

// 4. Declare initial set
if (workspaceCapability.declare.enabled && manager.list().length > 0) {
  await client.declare(RepoClient.snapshot(manager));
}

// 5. (optional) emit diffs as state changes
await client.changed({ added: [...], removed: [...] });
```

Total wire-up: ~30 lines in a typical sidecar's `connect()` flow.

---

## Trajectory-bootstrap interaction

When the hub speaks the trajectory protocol (cf. openhive's
`trajectory/checkpoint` handler), every checkpoint already carries
`gitRemoteUrl + projectPath + branch + gitCommitHash`. OpenHive's
trajectory-handler can lazily upsert repo + binding from those fields,
gated on `agent.capabilities.workspace.declare.enabled === true`.

The implication: agents that never explicitly call `client.declare` still
appear in the hub's repo list once they start a session — provided
`workspace.declare.enabled` is `true` in their capability declaration.
Agents that want to opt out completely should set
`OPENHIVE_WORKSPACE_DECLARE=off` (capability flag becomes `false`), which
disables both paths.

---

## Verification

- The hub's logs should show `x-workspace/repo.declare` arriving from the
  sidecar after connection. OpenHive emits a `workspace_added` event on the
  `map:repos` realtime channel for each binding.
- `agent-env doctor` (in agent-workspace) shows attached workspaces if the
  sidecar exposes its `RepoManager` via the environment-kind layer.
- OpenHive's REST `GET /api/v1/repos/:id/workspaces` (when shipped, slice 3)
  returns the active bindings.

---

## Reference implementation

OpenHive's end-to-end integration test
(`src/__tests__/integration/repo-end-to-end.test.ts`) exercises this
recipe in-process: a real `RepoClient` + `MockRepoTransport` from the
package, routed to a real `OpenHiveRepoHandler` + DAL persistence. The
test asserts the full agent → hub round-trip including DB state and
realtime broadcast emission. Treat it as the canonical "what wires to
what" reference.

---

## Cross-references

- [`architecture.md`](./architecture.md) — package architecture
- [`repo-kind.md`](./repo-kind.md) — protocol design + full API reference
- [`sandbox.md`](./sandbox.md) — sandbox layer (independent of repo kind)
- OpenHive `docs/design/repos-as-syncable-resources.md` — consumer-side
  design (DAL, REST, federation, swarm spawn integration)
