---
status: draft
owner: alexngai
created: 2026-05-05
revised: 2026-05-05
---

# Agent Workspace: Architecture and Direction

## Vision

Agent-workspace is the package for **the structured environment in which AI agents do their work** — filesystem layout, codebase context, sandbox boundary, and the wire protocol that coordinates these across processes and hubs.

Today the package narrowly handles one slice: a filesystem scratch directory for one-shot agent runs. But the trajectory is already visible in the codebase:

- `src/task/protocol.ts` defines `x-workspace/task.execute` JSON-RPC methods. The legacy constants (`WORKSPACE_METHODS_LEGACY` with `x-openhive/learning.workspace.*` names) confirm this protocol layer was extracted *out of openhive*. The package is already a home for cross-process workspace protocol.
- `src/sandbox.ts` integrates `@anthropic-ai/sandbox-runtime` as a lazy peer dependency, with a config-vs-handle split that generalizes naturally to other sandbox dimensions.
- `AgentBackend` is intentionally minimal (`spawn(config) → result`) and already abstracts over multiple agent runtimes (openhive MAP dispatch, cognitive-core subprocess, mocks for tests).

The next stages add two new **kinds** of workspace beyond the current one-shot task: a `repo` kind for long-lived codebase work with identity that federates across hubs, and an `environment` composer that holds multiple workspaces under a single policy umbrella with stronger sandboxing.

The package is small and pre-1.0; we have room to evolve abstractions deliberately rather than retrofit them.

## Scope of this document

This doc captures both the **current design** of agent-workspace and the **planned direction** for expansion. It is a single source of truth for the package's architecture; per-topic docs (sandbox v2, repo kind, environment composer) can land alongside this one as separate files in `docs/design/` once their details warrant separate treatment.

Specific decisions are tagged Dn for traceability. Implementation lands incrementally via subpath exports so existing consumers see no breakage.

---

## Part 1 — Current Architecture

### Core entities

| Term | Shape | Scope |
|---|---|---|
| `Workspace` | `{ id, path, dirs, createdAt, sandbox? }` | Ephemeral local FS instance |
| `WorkspaceManager` | `create / list / cleanup / pruneStale` | Lifecycle owner |
| `WorkspaceHandle` | I/O facade — section-scoped read/write/validate | Per-instance API |
| `WorkspaceMeta` | `.workspace.json` — `{ id, taskType, createdAt, dirs }` | On-disk identity |
| `Section` | Named subdir; closed set declared at creation | `dir(section)` namespace |

Default sections: `input | output | resources | scratch`. Custom sections via `additionalDirs` at create time.

The handle API is uniform: every reader and writer takes `(section, filePath, ...)`. `handle.dir(section)` resolves to an absolute path or throws synchronously if the section was not declared.

### Sandbox model

| Term | Role |
|---|---|
| `SandboxConfig` | Declarative — `{ enabled, network, filesystem, enableWeakerNestedSandbox }` |
| `SandboxNetworkConfig` | `allowedDomains / deniedDomains / allowLocalBinding` |
| `SandboxFilesystemConfig` | `denyRead / allowRead / extraWritePaths / denyWrite` |
| `SandboxHandle` | Runtime — `active / wrapCommand / cleanupAfterCommand / destroy` |
| `buildRuntimeConfig` | Translator: `SandboxConfig` → `@anthropic-ai/sandbox-runtime` shape |
| `initializeSandbox` | Factory: lazy-load peerDep, check platform/deps, init, return handle |

Default writable boundary is the workspace path itself. Network defaults to no access. Lazy peerDep loading means the package compiles and runs without `@anthropic-ai/sandbox-runtime` installed; sandbox features are opt-in at workspace creation via `CreateWorkspaceOptions.sandbox`.

### Task execution (`src/task/`)

| Term | Role |
|---|---|
| `TaskTemplate<TInput, TOutput>` | Declarative recipe — `taskType, domain, assessComplexity, prepareWorkspace, buildTaskPrompt, getSkills, getResources, outputConfig, collectOutput` |
| `TaskComplexity` | `heuristic \| lightweight \| standard \| thorough` |
| `AgentBackend` | `spawn(config: AgentSpawnConfig): Promise<AgentResult>` |
| `AgentSpawnConfig` | `agentType, prompt, cwd, systemContext?, timeout?, skills?` |
| `SkillSpec / ResourceSpec` | FS-rooted artifacts written into `skills/` and `resources/` |
| `TaskRunner` | Orchestrator: 10-step pipeline, hooks per-call (`TaskRunnerHooks`) |
| `TaskOutputError` | Thrown on validation failure |

The runner's lifecycle today:

1. `assessComplexity(input)` — heuristic shortcut or agentic
2. `WorkspaceManager.create()` — fresh dir
3. `template.prepareWorkspace(input, handle)` — write input files
4. Write `SkillSpec[]` to `skills/`
5. Apply `ResourceSpec[]` (file/symlink/directory) to `resources/`
6. `template.buildTaskPrompt(input)`
7. `hooks.onBeforeSpawn?` (optional config mutation)
8. `backend.spawn(config)` — agent runs
9. `hooks.onAfterSpawn?`
10. `handle.validateOutput(template.outputConfig)`
11. `template.collectOutput(handle)` — typed result
12. `hooks.onComplete?`
13. `WorkspaceManager.cleanup(handle)` — always, in `finally`

This is a one-shot, request-response pipeline. Workspaces are ephemeral by design — created at run start, deleted at run end.

### Wire protocol (`src/task/protocol.ts`)

```typescript
WORKSPACE_METHODS = {
  EXECUTE: 'x-workspace/task.execute',
  RESULT:  'x-workspace/task.result',
}
WORKSPACE_METHODS_LEGACY = {
  EXECUTE: 'x-openhive/learning.workspace.execute',
  RESULT:  'x-openhive/learning.workspace.result',
}
```

The legacy constants reveal that this module was extracted from openhive. That extraction is the precedent for what comes next: as openhive (and other hubs) accumulate workspace-related protocol surface, the protocol shapes belong in this package, not in any individual hub.

### Validation

`validateOutput(outputDir, OutputSpec) → ValidationResult` — non-throwing. Errors are collected as `{ path, message }` so callers can re-prompt agents with structured feedback. Reader functions throw; validation collects. This split is a load-bearing convention.

### Format readers/writers

`json`, `jsonl`, `markdown` (with YAML frontmatter), `raw`. Standalone-function form (`readJson(dir, path)`) and section-scoped form (`handle.readJson(section, path)`). The minimal `Schema<T>` interface (`{ parse(data): T }`) makes Zod, Joi, or any custom validator interoperable.

### Patterns that generalize cleanly

| Pattern | Why it extends |
|---|---|
| **`AgentBackend.spawn(config) → result`** | Transport-agnostic seam. Backends today: openhive MAP, cognitive-core subprocess, mock. Extends to MAP-via-agent-iam, remote-hosted, in-process. |
| **Workspace = `{ path, named sections }`** | Same shape applies to a repo clone (`section('repo')`, `section('output')`, `section('cache')`). |
| **Declarative-recipe-with-lifecycle** | The 6-stage `TaskTemplate` shape is a pipeline. Repo and environment templates override prepare/collect, add new stages. |
| **Wire-format module** | `task/protocol.ts` already lives here; siblings (`repo/protocol.ts`, `environment/protocol.ts`) extend the precedent. |
| **Config-vs-handle split** | `SandboxConfig` (declarative) ≠ `SandboxHandle` (runtime). Same shape for repo and environment configs/handles. |
| **Lazy peer-dep loading** | `loadSandboxRuntime()` proves the package can hold optional integrations cleanly. Same pattern for git ops, MAP transport, vault libs. |
| **Structured-failure result** | `validateOutput` returns `{ valid, errors }` rather than throwing. Same shape for declare-rejections, sandbox-violations, env-resolution errors. |

### Patterns that are narrow today

| Assumption today | Why it cracks |
|---|---|
| **One-shot task model** | `TaskTemplate` is request → response; runner's `try/finally → cleanup` is wrong for long-lived workspaces. |
| **`Section` ≡ subdirectory** | `handle.dir(section)` does `path.join(this.path, section)`. A repo clone, an external mount, or a remote URI doesn't fit. |
| **Single `cwd`** | `AgentSpawnConfig.cwd` is one string. Multi-root (LSP `workspaceFolders`, monorepo cousins) needs richer roots. |
| **Always create-fresh, always cleanup** | `WorkspaceManager.create()` mints ephemeral dirs; `cleanup()` deletes. Repo workspaces are persistent. |
| **Sandbox writes ≡ workspace path** | `allowWrite = [workspacePath, ...extra]`. Multi-root needs allow-list derived from declared roots. |
| **Skills/Resources assume FS** | Both write to disk. Broader environments include non-FS things (MCP server config, identity ref, inbox channel). |
| **Identity = local UUID** | `${taskType}-${timestamp}-${uuid}`. No canonical URL, no MAP registration, no hub-coordinated identity. |
| **`taskType` conflates name and kind** | Used as label *and* ID prefix. Adding repo/environment workspaces wants a `kind` discriminator separate from user-facing label. |
| **`validateOutput` is output-only** | No notion of "validate the *environment* is healthy" (right roots present, sandbox active, capabilities advertised). |

---

## Part 2 — Direction

### Design principles

1. **Generalize through kinds, not through replacement.** Existing task-run behavior keeps working unchanged; new kinds (`repo`, `environment`) are siblings, not supersessions.
2. **Pre-1.0 latitude, post-1.0 stability.** While we're <1.0, breaking shape changes are acceptable when justified; once shapes settle and 1.0 ships, deprecation cycles apply.
3. **Subpath exports to scope blast radius.** New modules ship under `agent-workspace/<submodule>` so consumers opt in; the default export stays narrowly the current API.
4. **Lazy peer-dep loading is the integration pattern.** New backends (git, MAP, vaults) follow the same shape as the sandbox runtime — optional peerDep, lazy-import, helpful error if missing.
5. **The package owns the protocol.** Wire formats for workspace lifecycle (task, repo, env) live in this package, not in the hubs that consume them. Hubs ship adapters; the package ships specs.
6. **Federate the abstract, keep the concrete local.** Repo identity (canonical URL) federates; per-agent instances (local clone path, branch, dirty state) stay local. Same shape as openhive's existing repo/workspace split.
7. **Sandbox is the safety boundary, not the configuration boundary.** Most sandbox policy is *derived* from what the rest of the workspace declares (sections, roots, skills, MCP servers); the sandbox layer adds resource limits and OS capabilities the rest can't express.

### Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Introduce `WorkspaceKind` discriminator** | Today: `taskType` is a free string used as label *and* dir prefix. Going forward: `kind: 'task-run' \| 'repo' \| 'environment'` selects the lifecycle/factory; `name` stays a free label. Existing API defaults `kind: 'task-run'`. |
| D2 | **`task-run` kind keeps current API verbatim** | Zero breakage. `WorkspaceManager.create(name)` stays a valid call; sets `kind: 'task-run'`. |
| D3 | **Add `repo` kind** | Long-lived, identity-bearing, multi-root capable, MAP-coordinated. Owns the canonical URL utility and `x-workspace/repo.*` protocol methods. |
| D4 | **Add `environment` kind** | Composer over multiple workspaces (typically: 1 repo + 1 task-run + sandbox + tools/permissions/identity refs). Holds the manifest format, resolver, and lockfile. |
| D5 | **Generalize `Section` to virtual sections** | `Section: { name, kind: 'subdir' \| 'mount' \| 'reference', root }`. `handle.dir(name)` resolves via section's `kind`. Subdir behavior unchanged for existing users; mount/reference enable repo clones and external resources. |
| D6 | **Split `WorkspaceManager` lifecycle into `create` + `attach`** | `create()` for ephemeral (current). `attach()` for persistent (open existing repo clone, refresh metadata, no auto-cleanup). Same `WorkspaceHandle` for both. |
| D7 | **Promote `task/protocol.ts` to top-level `protocol/` module** | Siblings: `protocol/task.ts`, `protocol/repo.ts`, `protocol/environment.ts`, `protocol/sandbox.ts`. The umbrella `WORKSPACE_METHODS` constant aggregates per-domain. |
| D8 | **Extract `AgentBackend` to top-level `backend/` module** | Today lives under `task/` because it's the only consumer. Repo and environment kinds need it too; promote it. |
| D9 | **`AgentBackend` gains an optional `attach` method** | One-shot semantics (`spawn`) stay; long-lived sessions add `attach(config) → AgentSession` (streaming events, lifecycle handle). Backends opt in; task-run never uses `attach`. |
| D10 | **Sandbox v2 with modes and derived policy** | `mode: 'none' \| 'advisory' \| 'enforce' \| 'strict'`. Most policy derives from declared sections / roots / skills via `derive: 'roots'` markers; explicit additions only for what derivation can't capture. v1 stays as fallback; v2 is opt-in via field. |
| D11 | **Identity is per-kind, not universal** | `task-run` identity = local UUID (current). `repo` identity = normalized `git_remote_url` (canonical). `environment` identity = manifest hash + name. `WorkspaceMeta` schema versioned (V1/V2) with a `kind` discriminator on V2. |
| D12 | **Lazy peer-dep pattern for all integrations** | `git-url-parse`, `@anthropic-ai/sandbox-runtime`, MAP transports, vault libs, etc. — all peer or optional, lazily imported, helpful error on missing. |
| D13 | **Hubs ship adapters, package ships specs** | OpenHive imports `agent-workspace/protocol/repo` for method names and types; OpenHive provides its own DAL/REST/UI/federation. The package never imports openhive-specific code. |
| D14 | **Subpath exports for new modules** | `agent-workspace/protocol`, `agent-workspace/sandbox`, `agent-workspace/kinds/repo`, `agent-workspace/kinds/environment`. Default export stays the current API surface plus the existing `task` re-exports. |
| D15 | **Validation generalizes from output-only to environment-health** | `validateOutput()` (current) checks files. Add `validateEnvironment()` checking section presence, sandbox liveness, declared capabilities advertised. Returns the same `ValidationResult` shape. |
| D16 | **`builtin/docker` sandbox backend follows nanoclaw's container-per-session model** | Per-session ephemeral containers (`--rm`), bind-mount allowlist as FS primitive, nested RO-over-RW for config integrity, credential proxy with fail-closed, narrow IPC (two-file pattern), per-install labels, supply-chain hygiene (`minimumReleaseAge`, `only-built-dependencies`). See [Reference implementation: nanoclaw](#reference-implementation-nanoclaw-d16) below. |

### Workspace kinds — the central new concept

Each kind owns its own factory, lifecycle, identity, section semantics, and protocol surface. The base `WorkspaceHandle` exposes only what's universal across kinds (id, sections, sandbox accessor, validation). Per-kind handles extend it with kind-specific accessors.

#### `task-run` (current)

| Property | Value |
|---|---|
| Identity | Local UUID (`${name}-${timestamp}-${uuid}`) |
| Sections | `input \| output \| resources \| scratch` (+ user-declared) |
| Lifecycle | `create()` → run → `cleanup()`. Always ephemeral. |
| Protocol | `x-workspace/task.execute`, `x-workspace/task.result` |
| Identity federates? | No. Local-only. |
| Multi-root? | No. Single workspace path. |

Use case: agent processes one prompt, writes structured outputs, validation gates the result, cleanup deletes everything. The current `TaskRunner` and `TaskTemplate` contract stays exactly as it is.

#### `repo` (new)

| Property | Value |
|---|---|
| Identity | Normalized `git_remote_url` (the federation key) |
| Sections | `repo` (the clone, virtual), `output`, `cache`, `scratch` (+ user-declared) |
| Lifecycle | `attach(canonical_url, local_path)` → use → `detach()`. Persistent. |
| Protocol | `x-workspace/repo.declare`, `.changed`, `.list`, `.retract` |
| Identity federates? | Yes. Canonical URL is the cross-hub key. |
| Multi-root? | Yes. Multiple repo workspaces can live under one environment. |

The `repo` kind owns:
- **Canonical URL utility** — `canonicalizeRepoUrl(input, opts) → CanonicalRepoIdentity`. The single string-comparison authority.
- **Repo declarations** — typed input that wraps `{ canonical_url, local_path, current_branch, head_sha, dirty, visibility, instance_label }`.
- **MAP method types** — request/response shapes for the four `x-workspace/repo.*` methods.
- **Repo lifecycle hooks** — `onDeclare`, `onChanged`, `onRetract` for hubs that consume the protocol.

The package does **not** own:
- Persistence (DAL is hub-side)
- Federation (mesh-sync materializer is hub-side)
- Visibility enforcement (hub-side per its policy layers)
- UI / REST routes (hub-side)

OpenHive is the reference consumer; see openhive's `CLAUDE.md` "Repos and Workspaces" section for the consumer-side persistence and federation design.

#### `environment` (new, composer)

| Property | Value |
|---|---|
| Identity | Manifest hash + manifest name |
| Sections | Composed from member workspaces |
| Lifecycle | `resolve(manifest)` → use → `dispose()` |
| Protocol | `x-workspace/env.activate`, `.describe`, `.reload`, `.dispose` |
| Identity federates? | Optionally. Manifests can be published as resources. |
| Multi-root? | Yes — one or more `repo` workspaces + one or more `task-run` workspaces composed. |

The `environment` kind composes other kinds under one policy umbrella:

```yaml
apiVersion: agent-workspace/v1
kind: Environment
metadata:
  name: openhive-dev
layers:
  identity:    { provider: agent-iam,   config: { ref: alex@personal } }
  inbox:       { provider: agent-inbox, config: { channels: [primary] } }
  repos:                                # uses kinds/repo
    provider: agent-workspace/kinds/repo
    config:
      declare:
        - { canonical_url: https://github.com/foo/bar, local_path: ~/code/bar }
  workspace:                            # uses kinds/task-run
    provider: agent-workspace/kinds/task-run
    config: { base_dir: ~/runs }
  tools:       { provider: builtin/mcp, config: { servers: [...] } }
  permissions: { provider: openhive/loadout, config: { ref: chat-agent } }
  compute:     { provider: builtin/local }
  sandbox:                              # the policy umbrella
    provider: builtin/anthropic-sandbox
    config:
      mode: enforce
      filesystem:
        allow:
          - { derive: repos }           # auto: repo local_paths
          - { derive: workspace }       # auto: task-run base_dir
          - { paths: ['/etc/ssl/certs'] }
        deny: { paths: ['~/.ssh', '~/.aws'] }
      network:
        allow:
          - { derive: inbox }
          - { derive: tools }
        deny_default: true
      limits: { memory_mb: 2048, max_duration_minutes: 60 }
secrets:       { provider: builtin/keychain }
```

The `environment` kind is the **least-privilege contract** for the agent's whole runtime: declare what you need, the resolver computes the sandbox policy from the declarations, and the agent is constrained accordingly.

### Section model evolution (D5)

```typescript
type Section =
  | { kind: 'subdir';    name: string; root: string }    // current — relative to workspace path
  | { kind: 'mount';     name: string; root: string }    // absolute path; bind-mount under sandbox
  | { kind: 'reference'; name: string; uri: string };    // logical handle, no FS

interface WorkspaceHandle {
  dir(name: string): string;            // throws for kind: 'reference'
  uri(name: string): string;            // works for any kind
  has(name: string): boolean;
  sections(): Section[];                // introspection
}
```

Backwards compatibility: every section declared via `additionalDirs` is still `kind: 'subdir'`. The repo kind adds `mount` (the clone path) and `reference` (the canonical URL).

### Identity model (D11)

`WorkspaceMeta` becomes versioned and kind-aware:

```typescript
interface WorkspaceMetaV1 {                     // current; persisted today
  id: string;
  taskType: string;
  createdAt: string;
  dirs: string[];
}

interface WorkspaceMetaV2 {
  version: 2;
  id: string;
  kind: WorkspaceKind;
  name: string;
  createdAt: string;
  sections: Section[];
  identity?: KindIdentity;   // discriminated by kind
}

type KindIdentity =
  | { kind: 'task-run';    uuid: string }
  | { kind: 'repo';        canonical_url: string; local_path: string; head_sha?: string }
  | { kind: 'environment'; manifest_hash: string; manifest_path?: string };
```

Reader auto-upgrades V1 → V2 on read; writer always emits V2. Pre-1.0 we accept this without a migration tool; post-1.0 we'd ship one.

### Sandbox v2 (D10) — the safety story

The single biggest expansion. Today's `SandboxConfig` is a flat declarative shape; v2 layers in modes, derived policy, and resource limits.

```typescript
interface SandboxConfigV2 {
  enabled: boolean;
  mode: 'none' | 'advisory' | 'enforce' | 'strict';

  filesystem?: {
    allow?: Array<FsRule | { derive: 'roots' | 'sections' }>;
    deny?:  Array<FsRule>;
  };
  network?: {
    allow?: Array<NetRule | { derive: 'tools' | 'inbox' | 'openhive' }>;
    deny?:  Array<NetRule>;
    deny_default?: boolean;
  };
  spawn?: {
    allow?: Array<SpawnRule | { derive: 'tools' }>;
    deny?:  Array<SpawnRule>;
    deny_default?: boolean;
  };
  limits?: {
    memory_mb?: number;
    cpu_percent?: number;
    disk_mb?: number;
    max_duration_minutes?: number;
    max_open_files?: number;
  };
  audit?: {
    log_violations: boolean;
    report_to?: string;       // URI for trajectory enrichment
  };

  enableWeakerNestedSandbox?: boolean;
}
```

**Modes:**

| Mode | Behavior |
|---|---|
| `none` | Layer present but no enforcement. Default. Backwards compat. |
| `advisory` | Compute policy, log violations, don't block. Audit / pre-prod tuning. |
| `enforce` | Block violations. Standard production. |
| `strict` | Enforce + deny-by-default everything not explicitly declared. Hosted swarms, untrusted inputs. |

**`derive:` markers.** Most policy is computed from the rest of the workspace, not hand-maintained:

| Marker | Resolves to |
|---|---|
| `derive: roots` | Every section's `root` (subdir + mount; reference excluded) |
| `derive: sections` | Same as `roots` plus the workspace path itself |
| `derive: tools` | MCP server endpoints + binaries declared in `tools` layer |
| `derive: inbox` | Inbox host:port from `inbox` layer |
| `derive: openhive` | OpenHive REST + WS endpoints if openhive consumer registered |

This makes sandbox declaration concise and **self-consistent with the workspace's other declarations** — adding a section automatically extends the sandbox allow-list; nothing has to be hand-mirrored.

**v1 → v2 translation.** When a consumer passes V1 `SandboxConfig`, the package translates it to V2 with `mode: 'enforce'`, no `derive:` markers, and the V1 fields applied verbatim. Existing tests pass unchanged.

### Reference implementation: nanoclaw (D16)

When the time comes to ship `builtin/docker` as a sandbox backend, treat [nanoclaw](https://github.com/qwibitai/nanoclaw)'s container approach as the reference implementation. Nanoclaw isolates one Anthropic-style agent per ephemeral Docker container with no IPC, no env-var secrets, and an explicit bind-mount allowlist — the **inside-of-one-sandbox primitive** is essentially solved there. Patterns to adopt verbatim:

| Pattern | nanoclaw location | What we adopt |
|---|---|---|
| **Per-session containers** | `src/container-runner.ts` `wakeContainer` | One container per `(agent, workspace, session)` triple. `docker run --rm`. No long-lived processes; container exists only while a message is being processed. |
| **Bind-mount allowlist** | `src/container-runner.ts` `buildMounts` | Explicit RW/RO declaration for every visible path. No `/Users`, no `~/.ssh`, no host net namespace, no Docker socket. Default is invisible. |
| **Nested RO over RW** | `container.json` mount inside the agent-group dir | Lets agent write working files in a directory while keeping specific files in that directory immutable. Worth stealing for `agent-environment.yml` integrity. |
| **Narrow IPC (two SQLite files)** | `inbound.db` (host writes, container reads) + `outbound.db` (container writes, host reads) | Each file has exactly one writer; no cross-mount lock contention. Heartbeat via `touch /workspace/.heartbeat`, not a DB row. Replaces sockets, named pipes, and stdin entirely. `journal_mode=DELETE` is load-bearing for cross-mount visibility. |
| **Credential proxy + fail-closed** | `onecli.applyContainerConfig` + `throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials')` | Inject `HTTPS_PROXY` + CA cert; gateway injects per-request credentials. Refuse to spawn if proxy not wired. Secrets never enter the container as env vars. |
| **Per-install labels** | `--label nanoclaw-install=<slug>` | Orphan cleanup is scoped to one install via `docker ps --filter label=...`. A peer install crash-looping cannot reap our containers. |
| **`tini` PID 1 + `exec` chain** | Dockerfile `ENTRYPOINT ["/usr/bin/tini", "--", ...]` + entrypoint does `exec bun ...` | Signal forwarding for graceful shutdown so `outbound.db` writes finalize on SIGTERM rather than getting orphaned by a shell wrapper. |
| **Image hierarchy** | base `nanoclaw-agent:latest` + per-group `nanoclaw-agent:<id>` overlays | Base image cached across all groups; per-group customization is an additive overlay rebuilt only on approved package additions. |
| **Layer ordering for cache hits** | Most-stable first (apt deps, Bun runtime), most-bumped last (pinned Node CLI versions via `ARG`) | Bumping the most frequently-changed package only invalidates one layer. |
| **Supply-chain hygiene** | `minimumReleaseAge: 4320` (3 days) + `only-built-dependencies` allowlist | New package versions must be on npm for 3 days before resolution; explicit list of packages allowed to run postinstall scripts. |
| **Self-modification approval flow** | `install_packages` / `add_mcp_server` MCP tools → admin DM → on-approve, rebuild per-group image and restart | Tier-1 self-mod (config additions) is gated by human approval. Tier-2 (source-level edits) is bounded out by architecture: `/app/src` is RO. Maps to our deferred `binding_policy: require_approval`. |
| **Optional micro-VM upgrade** | Docker Sandboxes (Firecracker) / Apple Container as opt-in alternatives to plain Docker | Same image surface, stronger isolation boundary as a runtime swap. Our sandbox-backend abstraction should make this a config switch, not a code change. |

Patterns nanoclaw doesn't address that we still need:

- **Multi-hub federation** of repo identity. Nanoclaw is local-only; agents have no canonical cross-hub identity. Our [`repo` kind](./repo-kind.md) adds this layer.
- **Multi-provider abstraction beyond Claude.** Nanoclaw has a `providers/` registry but it's tied to a specific spawn shape; our `AgentBackend` interface (D8) is more general.
- **Manifest-driven environment composition.** Nanoclaw's `container.json` is per-agent-group config, not a portable manifest that composes multiple workspaces under one policy. Our `environment` kind (D4) is novel.

The takeaway: **the local-isolation primitive is borrowed wholesale from nanoclaw; the federation, multi-provider, and composition layers are agent-workspace's own contribution.** When sandbox v2 specifies `builtin/docker`, the implementation document should cross-reference nanoclaw's `container/Dockerfile` and `src/container-runner.ts` directly rather than re-deriving the design.

### Protocol surface expansion (D7)

```
src/protocol/
  task.ts            # current task/protocol.ts contents
  repo.ts            # NEW
  environment.ts     # NEW
  sandbox.ts         # NEW — sandbox violation reporting
  index.ts           # WORKSPACE_METHODS umbrella + per-domain re-exports
```

```typescript
// protocol/repo.ts
export const REPO_METHODS = {
  DECLARE: 'x-workspace/repo.declare',
  CHANGED: 'x-workspace/repo.changed',
  LIST:    'x-workspace/repo.list',
  RETRACT: 'x-workspace/repo.retract',
} as const;

export interface RepoDeclareParams {
  workspaces: Array<{
    remote_url: string;
    local_path: string;
    current_branch?: string;
    head_sha?: string;
    dirty?: boolean;
    visibility?: 'private' | 'hub_local' | 'federated';
    instance_label?: string;
  }>;
}

export interface RepoChangedParams {
  added?: RepoDeclareParams['workspaces'];
  removed?: Array<{ canonical_url: string; local_path: string }>;
}

// ...etc
```

OpenHive (and any other hub) imports `agent-workspace/protocol/repo` to register handlers and validate request bodies. The package does not implement the handlers — it only owns the names, types, and contract docs.

### Backend abstraction evolution (D8, D9)

```typescript
// backend/types.ts
export interface AgentBackend {
  spawn(config: AgentSpawnConfig): Promise<AgentResult>;     // current — one-shot
  attach?(config: AgentAttachConfig): Promise<AgentSession>; // NEW — long-lived
}

export interface AgentSession {
  readonly id: string;
  events(): AsyncIterable<SessionEvent>;
  send(message: string): Promise<void>;
  permissions: { respond(requestId: string, outcome: 'approve' | 'deny'): Promise<void> };
  dispose(): Promise<void>;
}
```

Adding `attach` is opt-in per backend. The task-run kind never uses it. The repo kind uses it for long-lived sessions where the agent operates inside a clone over hours/days.

### Module structure

```
agent-workspace/
  src/
    core/
      handle.ts            # base WorkspaceHandle (sections, sandbox accessor, validate)
      manager.ts           # routes by kind to the right factory
      sections.ts          # Section types — subdir | mount | reference
      meta.ts              # WorkspaceMeta v1/v2 reader/writer
    sandbox/
      v1.ts                # current SandboxConfig + buildRuntimeConfig
      v2.ts                # NEW — modes, derive markers, limits
      handle.ts            # SandboxHandle (current)
      builtin/
        anthropic.ts       # current @anthropic-ai/sandbox-runtime integration
        none.ts            # no-op
    backend/
      types.ts             # extracted from task/types.ts
    formats/
      readers/             # current readers
      writers/             # current writers
      validation.ts        # current validateOutput + new validateEnvironment
    kinds/
      task-run/            # current default — one-shot, ephemeral
        manager.ts         # subset of current manager.ts
        handle.ts          # subset of current handle.ts
        template.ts        # TaskTemplate (from task/types.ts)
        runner.ts          # current task/runner.ts
      repo/                # NEW — long-lived, identity-bearing
        manager.ts
        handle.ts
        identity.ts        # canonicalizeRepoUrl + similarity
      environment/         # NEW — composer over multiple workspaces
        manager.ts
        handle.ts
        manifest.ts        # schema, reader, writer, compose
        resolver.ts        # provider registry, dependency-ordered resolution
        runtime.ts         # Environment object
    protocol/              # promoted from src/task/protocol.ts
      task.ts
      repo.ts              # NEW
      environment.ts       # NEW
      sandbox.ts           # NEW
      index.ts             # WORKSPACE_METHODS umbrella
    index.ts               # legacy re-exports unchanged
  tests/
  docs/
    design/
      architecture.md      # this file
      sandbox-v2.md        # future
      repo-kind.md         # future
      environment.md       # future
```

Subpath exports in `package.json`:

```json
{
  "exports": {
    ".":                  { "import": "./dist/index.js", ... },
    "./sandbox":          { "import": "./dist/sandbox/index.js", ... },
    "./backend":          { "import": "./dist/backend/index.js", ... },
    "./protocol":         { "import": "./dist/protocol/index.js", ... },
    "./protocol/task":    { "import": "./dist/protocol/task.js", ... },
    "./protocol/repo":    { "import": "./dist/protocol/repo.js", ... },
    "./kinds/task-run":   { "import": "./dist/kinds/task-run/index.js", ... },
    "./kinds/repo":       { "import": "./dist/kinds/repo/index.js", ... },
    "./kinds/environment":{ "import": "./dist/kinds/environment/index.js", ... }
  }
}
```

Existing imports (`import { WorkspaceManager } from 'agent-workspace'`) keep working unchanged. New consumers opt into submodules explicitly.

### Migration strategy

**v0.2.0-alpha — protocol promotion + meta versioning.** Move `task/protocol.ts` to `protocol/task.ts`; add `protocol/index.ts` umbrella. Add `WorkspaceMetaV2` reader (auto-upgrade), keep V1 writer for now. Existing tests unchanged.

**v0.3.0-alpha — backend extraction + Section generalization.** Promote `AgentBackend` to `backend/types.ts`. Generalize `Section` to discriminated type; `subdir` is the default and only kind in use. Existing `additionalDirs` still works.

**v0.4.0-alpha — `kinds/repo`.** Add the repo kind. Lazy peerDep on `git-url-parse`. Protocol module `protocol/repo.ts`. OpenHive becomes the first consumer; reference adapter ships in openhive's repo.

**v0.5.0-alpha — sandbox v2.** Add `SandboxConfigV2`, modes, `derive:` markers, limits. V1 translates to V2 with `mode: 'enforce'`, derive markers off. Audit logging hooks.

**v0.6.0-alpha — `kinds/environment`.** Manifest format, resolver, runtime. Composes existing kinds. CLI tool (`agent-env init/describe/activate/doctor`) ships as separate optional dep.

**v1.0.0 — settle and stabilize.** Promote each module from `experimental` → `stable` as it earns it. After 1.0, breaking changes require deprecation cycles.

### Threat model expansion

Once sandbox v2 ships, the package crosses from "convenience library" into "safety-relevant infrastructure." That changes:

- **CI requirements**: adversarial test matrix (manifests trying to escape sandbox), red-team review for sandbox provider PRs.
- **Release process**: sandbox changes get a higher bar than FS changes.
- **Dependency policy**: sandbox + env modules avoid runtime-pluggable third-party providers (or sandbox them); FS module stays loose.
- **Documentation**: explicit threat model section — what sandbox catches, what it doesn't, where the trust boundaries are.

Be eyes-open: expanding agent-workspace is also promoting it from "utility library" to "agent execution substrate." The trust placed in the package grows accordingly.

---

## Open questions

1. **Naming inside the package.** With the repo kind landing, `Workspace` is overloaded — task-run "workspace" is an FS scratch dir; repo "workspace" is an agent-clone pair. Subpath imports keep them lexically separate (`agent-workspace/kinds/task-run` exports `TaskRunWorkspace`; `agent-workspace/kinds/repo` exports `RepoWorkspace`). Is that enough? Lean: yes, with an explicit note in each kind's README about the distinction.

2. **Where do `compute` and `tools` providers live?** Environment manifest references them; their interfaces could live in this package (as provider contracts) or in their own packages. Lean: provider *interfaces* in this package (`agent-workspace/providers`); concrete implementations in their own packages or the consumer's repo.

3. **Can a single agent inhabit multiple environments?** Theoretically yes (cross-environment agent acting as a bridge). v0.x: not supported; one agent ↔ one active environment. Revisit if the use case appears.

4. **Lockfile format.** YAML, JSON, or its own. Lean: JSON for machine-friendliness; pretty-printed.

5. **Manifest extends and remote URLs.** `extends: https://...` is convenient but introduces remote-fetch attack surface. Lean: paths only in v0.6; HTTPS extends with explicit allow-list is v0.7+.

6. **Does the package itself ship a CLI?** `agent-env` for environment manipulation. Lean: separate optional package (`@agent-workspace/cli`) so the core stays library-only.

7. **Resource limits enforcement.** Anthropic sandbox-runtime supports some; cgroups for the rest on Linux; on macOS limits are coarser. Document what each backend can enforce.

8. **`task-run` backwards compatibility window.** When does the alias `taskType` → `name` get deprecated? Lean: through v1.0; remove in v2.0.

---

## Prior art

The directional design draws from:

| Source | Borrowed concept |
|---|---|
| **MCP `roots` capability** | Pull model + listChanged flag for the repo kind's protocol surface |
| **LSP `workspaceFolders`** | Multi-root pattern; `{ added, removed }` diff event shape |
| **Coder / Gitpod / DevPod / Codespaces** | Repo-vs-workspace identity split; persistent vs ephemeral lifecycle |
| **DevContainers `workspaceMount`/`workspaceFolder`** | Two-field identity (host vs guest); inspires our `subdir` vs `mount` section split |
| **`git-url-parse`** | Canonical URL normalization for the repo kind's identity |
| **GitLab visibility tiers** | Private / hub_local / federated tier shape (lives on the consumer/hub side, but the protocol exposes it) |
| **ActivityPub Tombstone** | Best-effort redaction with explicit "cannot be enforced" docs |
| **Kubernetes Pod spec** | Manifest + provider composition pattern for `environment` kind |
| **`package.json` + lockfile** | Manifest + lockfile pattern for environment reproducibility |
| **DevContainers `.devcontainer.json`** | Manifest format conventions; `customizations` extension pattern |
| **nanoclaw** | Reference implementation for `builtin/docker`: per-session ephemeral containers, bind-mount allowlist, two-file IPC, credential proxy with fail-closed, per-install labels, supply-chain hygiene. See [Reference implementation: nanoclaw](#reference-implementation-nanoclaw-d16). |

Where this design diverges: none of the prior art federates workspaces. Federation, redaction, and merge across mesh-connected hubs are novel; the protocol shapes for them are the package's own contribution. The safety-derived policy (`derive: roots` etc.) is also not common in existing sandboxing tools — most expect hand-maintained allow/deny lists. We're betting that derivation makes sandbox declaration tractable; if it doesn't pan out, the manual escape hatches remain.

---

## Cross-references

- **OpenHive consumer**: openhive's `CLAUDE.md` "Repos and Workspaces" section covers the *consumer-side* design — how openhive persists, federates, and exposes repos as syncable resources. It depends on the protocol shapes defined here.
- **OpenHive sandbox-runtime peer**: openhive's swarm-hosting providers can integrate with this package's sandbox layer when spawning hosted swarms.
- **agent-iam, agent-inbox**: peer packages that the `environment` kind composes via provider interfaces.
