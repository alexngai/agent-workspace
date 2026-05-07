---
status: draft
owner: alexngai
created: 2026-05-05
revised: 2026-05-05
---

# Sandbox: Design and Public API

## Scope

This doc covers **sandbox v2** in detail — the configuration shape, modes, derived policy, backend interface, public API, per-backend notes, subprocess policy, and audit federation. Background on why sandbox is a load-bearing layer for the package is in [`architecture.md`](./architecture.md) (D10, D16).

The package owns: configuration shapes, mode semantics, derive-marker resolution, the backend interface, the violation event format, redaction taxonomy, and bundled backend implementations. The package does not own: hub-specific enforcement (cf. consumer policy stacks), audit log persistence, or organization-wide policy distribution — those are consumer concerns.

The package is **hub-agnostic** by design. Builtin markers cover only workspace-internal concepts; hub/org-specific extensions go through the generic `SandboxResolveContext.custom` slot.

Sandbox v1 (current `SandboxConfig` in `src/sandbox.ts`) stays in place as a backwards-compatibility translation layer; v2 is opt-in. New code writes v2 directly.

---

## Naming convention

Same rule as [`repo-kind.md`](./repo-kind.md):

| Surface | Convention | Why |
|---|---|---|
| **In-memory TS types** (`SandboxConfigV2`, `ResolvedSandboxPolicy`, `SandboxHandle`, etc.) | `camelCase` | Idiomatic TypeScript. |
| **Wire types** (JSON-RPC params, mesh events, YAML manifest fields) | `snake_case` | JSON-RPC convention; matches existing `WorkspaceExecuteParams` shape. |
| **Constants** (`SANDBOX_CONFIG_VERSION`, `SANDBOX_PROTOCOL_VERSION`) | `SCREAMING_SNAKE` | JS convention. |

Translators at the boundary (e.g., `loadSandboxConfigFromYaml` → camelCase TS object) are explicit, hand-written, and shipped in `agent-workspace/sandbox/wire.ts`.

---

## Why sandbox v2

The current sandbox API does one thing well: wraps a command with `@anthropic-ai/sandbox-runtime` so writes go to the workspace path, network is denied by default, and a few extra paths can be added. That works for one-shot task runs but breaks down when:

- A workspace has **multiple roots** — the v1 single-`workspacePath` model can't express the multi-root allowlist.
- The agent **shouldn't see violations as errors** — log and continue (advisory mode), so operators can tune policy by watching real traffic.
- The hub wants to **derive** policy from the workspace's other declarations rather than hand-mirror it.
- The deployment target is a **container or microVM**, not a host process. v1 has no backend abstraction.
- The agent is **operating on credentials** that should never enter its memory space.
- An operator wants **resource limits** (memory, CPU, duration).
- Spawned subprocesses (git, node, MCP servers) need **narrower policy than the parent**.
- The agent's actions need an **audit trail** with privacy-aware federation.

These aren't features bolted onto v1; they require a different shape. v2 is that shape.

---

## Known limitations (v0.4)

| Limitation | Status |
|---|---|
| **MCP servers spawned by the agent inherit the agent's sandbox.** A compromised MCP server has the same FS/net/spawn rights as the agent. | v0.5+ — see [Subprocess policy](#subprocess-policy); per-tool MCP isolation gets its own design doc when v0.5 starts. |
| **Resource limits are best-effort per-backend.** macOS sandbox-exec doesn't enforce `memoryMb` / `cpuPercent` / `diskMb`. | v0.4 documents the gap via `SandboxBackend.supportedLimits()` and `agent-env doctor`; cross-platform PID supervisor is potential v0.5+ work. |
| **Advisory mode is not portable across all backends.** bubblewrap / docker can't observe-without-blocking cleanly. | v0.4 — backend declares `supportedModes()`; resolver downgrades to `enforce` with a warning, or errors under strict environments. |
| **Sandbox violations contain raw paths/hostnames.** If trajectories federate, violations federate too. | v0.4 ships full violations locally + classified federation by default. |
| **Custom backends are trusted code in your process.** A buggy or malicious backend can subvert containment. | Mitigated by strict-mode opt-in to refuse non-`builtin/*` backends (consumer-side). |
| **Sandbox escape via backend bug.** Mitigation is testing matrix and stronger backends (microVM > Docker > host process). | Inherent to the layer; choose backend appropriate to threat model. |

---

## Design principles

1. **The manifest is the least-privilege contract.** Most policy is *derived* from what the rest of the workspace declares. The sandbox layer adds only what derivation can't capture: resource limits, OS capabilities, catch-all denylists, advisory/strict modes, subprocess narrowing.
2. **Backend-agnostic configuration.** The same `SandboxConfigV2` resolves to a working sandbox on any supported backend.
3. **Hub-agnostic vocabulary.** Builtin markers cover only workspace-internal concepts. Extension via the generic `custom` slot.
4. **Mode is opt-in escalation.** `none → advisory → enforce → strict`.
5. **Derived policy is auditable.** `agent-env doctor` shows the resolved rule set.
6. **Violations are structured events.** Discriminated-union `intent`; classified before federation.
7. **Fail closed.** Misconfigured sandbox refuses to spawn the agent rather than running unsandboxed.
8. **Same image surface across stronger backends.** Docker → microVM is a backend swap, not a config rewrite.
9. **Subprocess policy narrows, never expands.**

---

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| S1 | **Four modes: `none` / `advisory` / `enforce` / `strict`** | `none` is back-compat; `advisory` is the migration runway; `enforce` is steady state; `strict` adds deny-by-default. |
| S2 | **`derive:` markers, builtin set is workspace-internal only** | `sections`, `tools`, `inbox`. Hub-specific concepts use the generic `custom` extension. |
| S3 | **Backend abstraction via `SandboxBackend` interface** | One config, multiple implementations. |
| S4 | **Resolution is a pure function: `resolveSandboxPolicy(config, ctx) → ResolvedSandboxPolicy`** | Pure data transformation. Testable. Resolved policies have no `derive:` markers. |
| S5 | **`builtin/docker` follows nanoclaw's container-per-session model** | Reference implementation; deferred to v0.5. |
| S6 | **Credential injection via proxy, not env vars** | Secrets resolve *inside* the sandbox boundary. Fail-closed if proxy not wired. |
| S7 | **Violations have structured intent + classification before federation** | `intent` is a discriminated union; `classifyViolation()` produces `FederatedSandboxViolation` with categorical labels for federation. |
| S8 | **Resource limits in config; backend declares which it enforces** | `SandboxBackend.supportedLimits()`; unsupported limits warn at activation, don't fail. |
| S9 | **Subprocess policy designed for v0.5; field reserved in v0.4 schema** | Per-binary narrowing of parent policy. Resolver enforces narrow-only validation. v0.4 accepts the config field but no-op + warns. |
| S10 | **v1 → v2 translation is automatic** | `SandboxConfig` (v1) wraps into `SandboxConfigV2` with `mode: 'enforce'`. |
| S11 | **Backend declares `supportedModes()`** | Mode unsupported → warn + downgrade to `enforce`; under strict environment → error. |
| S12 | **Backend `prepareImage()` is optional** | Backends with build steps implement; consumers can split slow-path from fast-path. |
| S13 | **Drop `enabled` field; use `mode === 'none'`** | v1 had both; v2 uses mode exclusively. |
| S14 | **Single high-level `createSandbox()` convenience** | Orchestrates the multi-step resolve → registry → init flow. Lower-level pieces stay exported for advanced use. |
| S15 | **Extensible classification taxonomy** | `classifyViolation()` accepts `extraClassifiers`; result carries `classificationVersion`. |
| S16 | **Per-axis `custom` resolvers** | `custom: { filesystem?, network?, spawn? }` instead of mixed array. Avoids cross-axis type mismatches. |

---

## Modes

| Mode | Behavior | Use case |
|---|---|---|
| `none` | Layer present but no enforcement. Default. Backwards compat. | Local dev, trusted hands-on. |
| `advisory` | Compute policy, log every violation, **don't block**. | Pre-prod tuning. |
| `enforce` | Block violations. Standard production. | Hosted swarms with developer in the loop. |
| `strict` | Enforce + deny-by-default for everything not explicitly declared. | Hosted swarms, autonomous dispatch, untrusted inputs. |

### Mode partial order

In **restrictiveness** (least → most): `none < advisory < enforce < strict`.

This order is referenced everywhere mode comparison matters:
- Subprocess policy: subprocess `mode` must be ≥ parent in restrictiveness (cannot be more permissive).
- Backend downgrade fallback: when a backend can't support the requested mode, the resolver falls back to `enforce` (the closest more-restrictive mode it can guarantee), or errors under strict environment.
- Mode → `denyDefault` mapping (see below).

### Mode → `denyDefault` mapping

The resolver applies these rules deterministically:

| Mode | `network.denyDefault` | `spawn.denyDefault` |
|---|---|---|
| `none` | inherits config (default `false`) | inherits config (default `false`) |
| `advisory` | inherits config | inherits config |
| `enforce` | inherits config | inherits config |
| `strict` | **forced `true`**; explicit `false` in config emits warning and is overridden | **forced `true`**; same |

So `mode: 'strict'` is shorthand for "deny-by-default everywhere"; explicit `denyDefault: false` under strict is preserved as a warning trail in `agent-env doctor` but the resolved policy has it as `true`.

### Backend support for modes

```typescript
interface SandboxBackend {
  supportedModes(): readonly SandboxMode[];
}
```

| Backend | `none` | `advisory` | `enforce` | `strict` |
|---|---|---|---|---|
| `builtin/none` | ✓ | ✓ (trivially) | ✓ (trivially) | ✓ (trivially) |
| `builtin/anthropic` | ✓ | ✓ | ✓ | ✓ |
| `builtin/sandbox-exec` | ✓ | ✓ (report-only profiles) | ✓ | ✓ |
| `builtin/bubblewrap` | ✓ | ✗ (downgrades to enforce) | ✓ | ✓ |
| `builtin/docker` | ✓ | partial | ✓ | ✓ |
| `builtin/firecracker` | ✓ | ✗ | ✓ | ✓ |

Resolver behavior:

```typescript
function resolveMode(
  requested: SandboxMode,
  backend: SandboxBackend,
  env: { strict: boolean },
): SandboxMode {
  if (backend.supportedModes().includes(requested)) return requested;
  if (env.strict) {
    throw new ResolutionError(
      'mode',
      `Backend ${backend.id} does not support mode=${requested}; pick a different backend or change mode`,
    );
  }
  warn(`Backend ${backend.id} does not support mode=${requested}; falling back to enforce`);
  return 'enforce';
}
```

---

## Configuration model

```typescript
// agent-workspace/sandbox/v2.ts

export type SandboxMode = 'none' | 'advisory' | 'enforce' | 'strict';

export interface SandboxConfigV2 {
  mode: SandboxMode;
  backend?: SandboxBackendId;            // default 'builtin/none' when mode='none', else required

  filesystem?: {
    allow?: Array<FsRule | DeriveMarker>;
    deny?:  Array<FsRule>;
  };
  network?: {
    allow?: Array<NetRule | DeriveMarker>;
    deny?:  Array<NetRule>;
    denyDefault?: boolean;
  };
  spawn?: {
    allow?: Array<SpawnRule | DeriveMarker>;
    deny?:  Array<SpawnRule>;
    denyDefault?: boolean;
  };
  limits?: {
    memoryMb?: number;
    cpuPercent?: number;
    diskMb?: number;
    maxDurationMinutes?: number;
    maxOpenFiles?: number;
  };
  audit?: {
    logViolations?: boolean;             // default false
    reportTo?: string;
    federation?: {
      mode: 'none' | 'classified' | 'full';   // default 'classified'
    };
  };
  credentials?: {
    proxy?: {
      provider: string;
      config?: Record<string, unknown>;
    };
    failClosed?: boolean;                // default false
  };

  /** Subprocess narrowing — see Subprocess policy. v0.4 accepts but does not enforce. */
  subprocessPolicy?: SubprocessPolicy[];
}

export interface FsRule {
  paths: string[];
  mode?: 'ro' | 'rw';                    // default: 'rw' for allow, irrelevant for deny
}
export interface NetRule {
  hosts: string[];                       // 'github.com:443', '*.npmjs.org', 'localhost'
}
export interface SpawnRule {
  binaries: string[];                    // 'git', 'node', '/usr/bin/curl'
}

export interface DeriveMarker {
  derive: 'sections' | 'tools' | 'inbox' | string;
}

export const SANDBOX_CONFIG_VERSION = '2' as const;
```

### Builtin derive markers

Resolved at activation against the resolve context:

| Marker | Resolves to |
|---|---|
| `derive: sections` | Every section's `root` path (subdir + mount kinds; reference excluded) plus the workspace path itself |
| `derive: tools` | MCP server binaries declared in tools layer (spawn allow) + endpoints (network allow) |
| `derive: inbox` | Inbox host:port from inbox layer |

Three markers, each tied to a specific axis. If a marker is used and the corresponding context field is missing, it resolves to empty rules with a warning — never errors.

### Custom markers (consumer extension)

Per-axis to avoid cross-axis type mismatches:

```typescript
export interface SandboxResolveContext {
  workspace: { path: string; sections: Section[] };
  tools?: { binaries: string[]; endpoints: string[] };
  inbox?: { host: string; port: number };
  custom?: {
    filesystem?: Record<string, (ctx: ResolverArgContext) => FsRule[]>;
    network?:    Record<string, (ctx: ResolverArgContext) => NetRule[]>;
    spawn?:      Record<string, (ctx: ResolverArgContext) => SpawnRule[]>;
  };
}

/** Subset of SandboxResolveContext passed to custom resolvers (no `custom` to avoid recursion). */
export interface ResolverArgContext {
  workspace: { path: string; sections: Section[] };
  tools?: { binaries: string[]; endpoints: string[] };
  inbox?: { host: string; port: number };
}
```

Markers can have the same name across axes (`'platform-services'` resolves differently for fs vs net). The resolver picks the right one based on which axis the `derive: 'platform-services'` marker appears under.

The package itself ships zero custom markers. Consumers own this namespace; we recommend prefixing custom marker names (`acme/foo`) to avoid collision across consumers.

### Rule precedence within an axis

For `filesystem.allow`, multiple rules can overlap. Resolution rule:

> **Most-specific path wins.** Longer matching prefix takes precedence. On equal specificity, later rule in the array wins.

So `[{ paths: ['/a'], mode: 'rw' }, { paths: ['/a/b'], mode: 'ro' }]` resolves: `/a/b` is `ro` (more specific), `/a/c` inherits `rw` from the parent rule.

`network` and `spawn` use exact match with wildcard support; precedence is "exact > wildcard > fallback denyDefault."

### Resolution

```typescript
export interface ResolvedSandboxPolicy {
  mode: SandboxMode;
  backend: SandboxBackendId;
  filesystem: { allow: FsRule[]; deny: FsRule[] };
  network: { allow: NetRule[]; deny: NetRule[]; denyDefault: boolean };
  spawn: { allow: SpawnRule[]; deny: SpawnRule[]; denyDefault: boolean };
  limits: ResolvedLimits;
  audit: ResolvedAudit;
  credentials: ResolvedCredentials;
  subprocessPolicies: ResolvedSubprocessPolicy[];
}

export interface ResolvedLimits {
  memoryMb?: number;
  cpuPercent?: number;
  diskMb?: number;
  maxDurationMinutes?: number;
  maxOpenFiles?: number;
}

export interface ResolvedAudit {
  logViolations: boolean;             // always set after resolution
  reportTo?: string;
  federation: { mode: 'none' | 'classified' | 'full' };  // always set
}

export interface ResolvedCredentials {
  proxy?: { provider: string; config?: Record<string, unknown> };
  failClosed: boolean;                 // always set
}

export function resolveSandboxPolicy(
  config: SandboxConfigV2,
  ctx: SandboxResolveContext,
): ResolvedSandboxPolicy;
```

The resolver:
1. Validates the config (delegates to `validateSandboxConfigV2`).
2. Resolves `derive:` markers via builtin handlers and `ctx.custom.<axis>`.
3. Applies mode → `denyDefault` mapping.
4. Dedups rules.
5. Validates subprocess narrow-only.
6. Returns `ResolvedSandboxPolicy` with all fields populated.

After resolution, every rule is literal — no markers. Backends consume only `ResolvedSandboxPolicy`.

### Pre-resolve validation

```typescript
export function validateSandboxConfigV2(config: SandboxConfigV2): ValidationResult;
```

Non-throwing. Catches issues without instantiating a backend:

- `mode: 'none'` with extensive policy rules (warning: "policy will not be enforced").
- Unknown derive markers (error).
- Subprocess `mode` more permissive than parent (error).
- Subprocess matching no parent rule for narrow-only validation (error).
- Cross-axis type mismatch in custom markers (error).

Same `{ valid, errors }` shape as `validateOutput` — load-bearing convention from v1.

---

## Backend interface

```typescript
// agent-workspace/sandbox/backend.ts

export type SandboxBackendId =
  | 'builtin/none'
  | 'builtin/anthropic'
  | 'builtin/sandbox-exec'
  | 'builtin/bubblewrap'
  | 'builtin/docker'
  | string;

export interface SandboxBackend {
  readonly id: SandboxBackendId;
  readonly version: string;

  isSupported(): Promise<{ supported: boolean; reason?: string; warnings: string[] }>;
  supportedModes(): readonly SandboxMode[];
  supportedLimits(): readonly (keyof ResolvedLimits)[];
  supportsSubprocessPolicy(): boolean;

  prepareImage?(policy: ResolvedSandboxPolicy): Promise<{
    imageId: string;
    built: boolean;
    buildLog?: string;
  }>;

  initialize(
    policy: ResolvedSandboxPolicy,
    ctx: SandboxBackendContext,
  ): Promise<SandboxHandle>;
}

export interface SandboxBackendContext {
  workspacePath: string;
  installLabel?: string;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface SandboxHandle {
  readonly active: boolean;
  readonly mode: SandboxMode;
  readonly backend: SandboxBackendId;
  readonly policy: ResolvedSandboxPolicy;

  /** Wrap a shell command. Returns the wrapped command + any env vars the consumer
   *  should set when execing (e.g. HTTPS_PROXY for credential injection). */
  wrapCommand(
    command: string,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<{ command: string; env?: Record<string, string> }>;

  /** Stream of violations observed while this sandbox is active.
   *  Iteration ends naturally when the handle is destroyed. */
  events(): AsyncIterable<SandboxViolation>;

  cleanupAfterCommand(): Promise<void>;
  destroy(): Promise<void>;
}
```

### `prepareImage` retry/failure

If `prepareImage()` rejects, the consumer sees the error directly — the package does not retry automatically. Backends may cache transient build failures briefly to avoid hammering on repeated fast-failures, but this is a backend implementation detail. Document in each backend's notes.

Consumers handling user-facing errors should:
1. Show the build log to the user (via `buildLog` on success or error message on failure).
2. Allow manual retry.
3. Suggest backend swap if the failure is structural (Docker daemon not running, etc.).

---

## High-level convenience

Most consumers don't want to orchestrate the full resolve → registry → init flow. The package ships a single entry point:

```typescript
// agent-workspace/sandbox/createSandbox.ts

export interface CreateSandboxOptions {
  /** Optional registry; defaults to `defaultBackendRegistry`. */
  registry?: SandboxBackendRegistry;
  /** Optional backend context (workspacePath required from caller or derived from config). */
  backendCtx?: Partial<SandboxBackendContext>;
  /** Skip prepareImage even if backend supports it. Default false. */
  skipPrepareImage?: boolean;
  /** Strict environment — backend mode mismatches throw instead of falling back. Default false. */
  strict?: boolean;
}

export async function createSandbox(
  config: SandboxConfigV2,
  ctx: SandboxResolveContext,
  options?: CreateSandboxOptions,
): Promise<SandboxHandle>;
```

Steady-state usage:

```typescript
const sandbox = await createSandbox(config, { workspace: { path, sections } });
const { command, env } = await sandbox.wrapCommand('git status');
const child = spawn('sh', ['-c', command], { env: { ...process.env, ...env } });
// ...
await sandbox.destroy();
```

Lower-level pieces (`resolveSandboxPolicy`, registry lookups, manual `initialize`) stay exported for advanced use — testing, custom registries, splitting `prepareImage` into its own slow-path stage.

---

## Subprocess policy

**Status:** designed in v0.4 schema, **enforced in v0.5+**. v0.4 accepts the config field but does not apply narrowing.

### Why

Today, child processes spawned by the agent inherit its full sandbox boundary. Subprocess policy provides per-binary narrowing without changing how the agent itself is sandboxed.

### Shape

```typescript
export interface SubprocessPolicy {
  match: {
    binaries: string[];
    argvPrefix?: string[];
  };

  filesystem?: { allow?: FsRule[]; deny?: FsRule[] };
  network?: { allow?: NetRule[]; deny?: NetRule[]; denyDefault?: boolean };
  spawn?: { allow?: SpawnRule[]; deny?: SpawnRule[]; denyDefault?: boolean };
  limits?: ResolvedLimits;
  mode?: SandboxMode;
}

export interface ResolvedSubprocessPolicy {
  match: SubprocessPolicy['match'];
  effective: {
    mode: SandboxMode;
    filesystem: { allow: FsRule[]; deny: FsRule[] };
    network: { allow: NetRule[]; deny: NetRule[]; denyDefault: boolean };
    spawn: { allow: SpawnRule[]; deny: SpawnRule[]; denyDefault: boolean };
    limits: ResolvedLimits;
  };
}
```

### Match precedence

Multiple subprocess policies may match a given spawn. Resolution rule:

> **Most-specific match wins** (more `match.*` conditions specified). On equal specificity, later policy in the array wins.

Examples:
- `match: { binaries: ['git'] }` matches `git push origin main`.
- `match: { binaries: ['git'], argvPrefix: ['push'] }` is more specific — it wins.
- Two policies with `match: { binaries: ['git'] }` — last in array wins.

### Narrow-only validation

Subprocess policy can only restrict, never expand. The resolver enforces at resolution time:

| Axis | Rule |
|---|---|
| `filesystem.allow` | Each rule must be a subset of parent's `filesystem.allow` (path under a parent-allowed prefix; mode at most as permissive). |
| `filesystem.deny` | Always allowed (additional denies). |
| `network.allow` | Every host must be a subset of parent's `network.allow`. |
| `network.deny` | Always allowed. |
| `network.denyDefault` | Cannot relax `true` → `false`. |
| `spawn.allow` | Every binary must be on parent's `spawn.allow`. |
| `spawn.deny` | Always allowed. |
| `spawn.denyDefault` | Same as network. |
| `limits` | Every limit must be ≤ parent's limit. |
| `mode` | Cannot be more permissive than parent (per [Mode partial order](#mode-partial-order)). |

Violations produce `SubprocessPolicyError` (subclass of `ResolutionError`) at resolve time:

```typescript
export class SubprocessPolicyError extends ResolutionError {
  readonly subErrorCode: 'narrow_violation' | 'no_parent_rule' | 'mode_more_permissive';
  constructor(
    public axis: 'filesystem' | 'network' | 'spawn' | 'limits' | 'mode',
    public detail: string,
    public parentRule?: unknown,
    public attemptedRule?: unknown,
  );
}
```

### Backend support

```typescript
interface SandboxBackend {
  supportsSubprocessPolicy(): boolean;
}
```

| Backend | Subprocess support |
|---|---|
| `builtin/none` | trivial (no enforcement either way) |
| `builtin/anthropic` | ✓ (re-wrap on spawn) |
| `builtin/sandbox-exec` | ✓ (per-process profiles) |
| `builtin/bubblewrap` | ✓ (wrap child exec) |
| `builtin/docker` | ✗ (per-tool sandbox is the v0.5 MCP-isolation design) |
| `builtin/firecracker` | ✗ (same) |

Backends without support log a warning at activation when `subprocessPolicy` is present; under strict environment, error out.

### v0.4 vs v0.5 phasing

- **v0.4**: schema accepts `subprocessPolicy`; resolver validates narrow-only; backends log warnings; *no actual enforcement*.
- **v0.5**: backends with `supportsSubprocessPolicy() === true` enforce. Per-tool MCP isolation gets its own design doc (`docs/design/sandbox-mcp-isolation.md`).

Manifests written today against v0.4 keep working in v0.5 — they just become *enforced* when the consumer upgrades.

---

## Violations and audit

### Structured violation

```typescript
export type ViolationLayer = 'fs' | 'net' | 'spawn' | 'limit' | 'cred';

export type ViolationIntent =
  | { kind: 'fs.read';      path: string }
  | { kind: 'fs.write';     path: string }
  | { kind: 'fs.exec';      path: string }
  | { kind: 'net.connect';  host: string; port: number; protocol?: string }
  | { kind: 'net.listen';   host: string; port: number }
  | { kind: 'spawn.exec';   binary: string; argv: string[] }
  | { kind: 'limit.exceeded'; resource: keyof ResolvedLimits; current: number }
  | { kind: 'cred.missing'; reason: string };

export type ViolationRule =
  | { kind: 'allow_no_match'; axis: 'fs' | 'net' | 'spawn' }
  | { kind: 'explicit_deny';  axis: 'fs' | 'net' | 'spawn'; ruleIndex: number }
  | { kind: 'limit_exceeded'; limit: keyof ResolvedLimits }
  | { kind: 'cred_missing' };

export interface SandboxViolation {
  sessionId: string;                   // required — synthetic if no session context
  layer: ViolationLayer;
  intent: ViolationIntent;             // structured
  rule: ViolationRule;                 // structured
  description: string;                 // human-readable derived from intent + rule
  blocked: boolean;
  timestamp: string;
  backend: SandboxBackendId;
}
```

The structured `intent` and `rule` make `classifyViolation()` trivial — switch on `intent.kind`, route to the typed classifier. No string parsing.

### Federation modes

```yaml
audit:
  federation:
    mode: 'classified'   # default
```

| Mode | What peers see |
|---|---|
| `none` | Nothing. |
| `classified` | `FederatedSandboxViolation` with categorical `intentClass`. **Default.** |
| `full` | Raw `SandboxViolation`. Opt-in only — for tightly-controlled meshes. |

Local consumers always see the full raw form via `SandboxHandle.events()`.

### Federated shape

```typescript
export const SANDBOX_CLASSIFICATION_VERSION = '1' as const;

export interface FederatedSandboxViolation {
  sessionId: string;
  agentId: string;
  layer: ViolationLayer;
  intentClass: string;       // categorical — see taxonomy
  ruleClass: 'allow_no_match' | 'explicit_deny' | 'limit_exceeded' | 'cred_missing';
  blocked: boolean;
  timestamp: string;
  backend: string;
  classificationVersion: string;   // = SANDBOX_CLASSIFICATION_VERSION at emit time
}
```

`classificationVersion` lets receivers handle taxonomy upgrades gracefully — unknown classes treated as opaque strings.

### Classification taxonomy (v1)

#### Filesystem (`layer: 'fs'`)

| Class | Examples |
|---|---|
| `system_path` | `/etc/*`, `/sys/*`, `/proc/*`, `/var/log/*` |
| `user_credentials` | `~/.ssh`, `~/.aws`, `~/.gcloud`, `~/.gnupg`, `~/.kube`, `~/.config/*credential*` |
| `home_path` | Anything else under `$HOME` |
| `tmp_path` | `/tmp/*`, `$TMPDIR/*` |
| `root_path` | Anything else under `/` |
| `unknown_path` | Fallback |

#### Network (`layer: 'net'`)

| Class | Examples |
|---|---|
| `local_loopback` | `127.0.0.1`, `localhost`, `::1` |
| `private_network` | `10.*`, `192.168.*`, `172.16-31.*`, `*.local` |
| `external_dns` | Public hostnames or IPs |
| `unknown_endpoint` | Fallback |

#### Spawn (`layer: 'spawn'`)

| Class | Examples |
|---|---|
| `interpreter` | `node`, `python`, `ruby`, `perl`, `bash`, `sh`, `zsh` |
| `network_tool` | `curl`, `wget`, `nc`, `ssh`, `scp`, `rsync` |
| `package_manager` | `npm`, `pip`, `apt`, `yum`, `brew`, `cargo`, `gem` |
| `version_control` | `git`, `hg`, `svn` |
| `archive_tool` | `tar`, `gzip`, `unzip`, `7z` |
| `shell_builtin` | Anything commonly built into a shell |
| `unknown_binary` | Fallback |

### Extensible classification

Consumers can add custom classes:

```typescript
export type ClassifierFn = (violation: SandboxViolation) => string | null;

export function classifyViolation(
  violation: SandboxViolation,
  options?: { extraClassifiers?: ClassifierFn[] },
): FederatedSandboxViolation;
```

Classifier resolution: extra classifiers run first; first non-null wins. Builtin taxonomy is the fallback. Custom classes should use a prefix (`acme/foo`) to avoid collision with future builtin additions.

`classifyViolation` never throws — falls through to `unknown_<layer>` if nothing matches.

---

## Bundled backends

| Backend | Status | Platforms | Modes | Subprocess |
|---|---|---|---|---|
| `builtin/none` | v0.4 | All | all | trivial |
| `builtin/anthropic` | v0.4 | macOS, Linux (incl. WSL2) | all | ✓ (v0.5) |
| `builtin/sandbox-exec` | v0.4 | macOS only | all (advisory partial) | ✓ (v0.5) |
| `builtin/bubblewrap` | v0.4 | Linux only | none / enforce / strict | ✓ (v0.5) |
| `builtin/docker` | designed for v0.5 | All (Docker required) | all (advisory partial) | ✗ |
| `builtin/firecracker` | v1.0 | Linux | none / enforce / strict | ✗ |
| `builtin/apple-container` | v1.0 | macOS | none / enforce / strict | ✗ |
| Custom | n/a | n/a | declared | declared |

### Backend layering note

`builtin/anthropic` wraps `@anthropic-ai/sandbox-runtime`, which itself uses bubblewrap on Linux and sandbox-exec on macOS. So `anthropic` is a cross-platform backend that delegates to the OS-specific primitives via Anthropic's SDK.

`builtin/bubblewrap` and `builtin/sandbox-exec` are *direct* backends — they call bubblewrap/sandbox-exec themselves without the SDK. Useful when you want to skip the SDK dependency or need finer control. Most users should pick `builtin/anthropic`; the direct backends exist for advanced cases.

---

## `builtin/docker`: the nanoclaw pattern

When this backend ships in v0.5, it adopts [nanoclaw](https://github.com/qwibitai/nanoclaw)'s container model wholesale rather than re-deriving the design. **For v0.4, the design path stays open but no implementation lands.**

What the docker backend will adopt: per-session ephemeral containers with `--rm`; bind-mount allowlist with nested RO over RW; narrow IPC (two SQLite files via `TwoFileIpc` helper); credential proxy + fail-closed; image hierarchy (base + per-group overlays); supply-chain hygiene; per-install labels for orphan-cleanup scoping; tini PID 1 + exec chain for signal forwarding. Self-modification approval flow gated by human approval. MicroVM upgrade path via backend swap.

Full pattern table is in [`architecture.md` → Reference implementation: nanoclaw](./architecture.md#reference-implementation-nanoclaw-d16); the implementation doc when v0.5 starts will cross-reference nanoclaw's `container/Dockerfile`, `src/container-runner.ts`, and `onecli.applyContainerConfig` directly.

---

## `TwoFileIpc` helper

For backends that want the nanoclaw two-file IPC pattern. Generic over message types; lazy peer dependency on `better-sqlite3`.

```typescript
// agent-workspace/sandbox/ipc.ts

export interface TwoFileIpcOptions {
  ipcDir: string;
  journalMode?: 'DELETE' | 'WAL';     // default 'DELETE' for cross-mount visibility
}

export class TwoFileIpc<TIn = unknown, TOut = unknown> {
  constructor(options: TwoFileIpcOptions);

  writeInbound(message: TIn): Promise<void>;
  readInbound(): AsyncIterable<TIn>;

  writeOutbound(message: TOut): Promise<void>;
  readOutbound(): AsyncIterable<TOut>;

  touchHeartbeat(): Promise<void>;
  watchHeartbeat(intervalMs: number): AsyncIterable<{ alive: boolean; lastSeen: number }>;
}
```

Lazy import: instantiating `TwoFileIpc` triggers loading `better-sqlite3` with a helpful error if missing. The package compiles and runs without it.

---

## Wire protocol

```typescript
// agent-workspace/protocol/sandbox.ts

export const SANDBOX_PROTOCOL_VERSION = '1' as const;

export const SANDBOX_METHODS = {
  VIOLATION: 'x-workspace/sandbox.violation',
} as const;

export interface SandboxViolationParams {
  session_id: string;
  agent_id: string;
  raw?: SandboxViolationWire;
  classified?: FederatedSandboxViolationWire;
  classification_version?: string;
}
```

Wire types use snake_case; in-memory types camelCase. Translators in `agent-workspace/sandbox/wire.ts` convert at the boundary.

---

## Backend registry

```typescript
// agent-workspace/sandbox/registry.ts

export class SandboxBackendRegistry {
  register(backend: SandboxBackend): void;
  get(id: SandboxBackendId): SandboxBackend | undefined;
  list(): SandboxBackend[];
}

/** Default registry shipped with all `builtin/*` backends pre-registered. */
export const defaultBackendRegistry: SandboxBackendRegistry;
```

`createSandbox()` uses `defaultBackendRegistry` if no registry passed in `options.registry`. Consumers building custom environments construct their own registry; tests get isolated registries.

---

## v1 → v2 translation

Existing consumers pass `SandboxConfig` (v1); the translator wraps:

```typescript
export function translateV1ToV2(v1: SandboxConfig): SandboxConfigV2 {
  return {
    mode: v1.enabled ? 'enforce' : 'none',
    backend: 'builtin/anthropic',
    filesystem: {
      allow: [
        { derive: 'sections' },
        ...(v1.filesystem?.extraWritePaths?.map(p => ({ paths: [p], mode: 'rw' as const })) ?? []),
        ...(v1.filesystem?.allowRead?.map(p => ({ paths: [p], mode: 'ro' as const })) ?? []),
      ],
      deny: [
        ...(v1.filesystem?.denyRead?.map(p => ({ paths: [p] })) ?? []),
        ...(v1.filesystem?.denyWrite?.map(p => ({ paths: [p] })) ?? []),
      ],
    },
    network: {
      allow: v1.network?.allowedDomains?.map(host => ({ hosts: [host] })) ?? [],
      deny:  v1.network?.deniedDomains?.map(host => ({ hosts: [host] })) ?? [],
      denyDefault: !v1.network?.allowLocalBinding,
    },
    audit: {
      logViolations: false,
      federation: { mode: 'none' },
    },
  };
}
```

`WorkspaceManager.create({ sandbox: <v1> })` continues to work; under the hood translates to v2 and routes through the new resolver/backend.

---

## Public API summary

```typescript
// agent-workspace/sandbox/index.ts

// Configuration types (camelCase, in-memory)
export type {
  SandboxMode, SandboxConfigV2, SandboxBackendId,
  FsRule, NetRule, SpawnRule, DeriveMarker,
  SubprocessPolicy, ResolvedSubprocessPolicy,
  ResolvedSandboxPolicy, ResolvedLimits, ResolvedAudit, ResolvedCredentials,
  SandboxResolveContext, ResolverArgContext,
  ViolationLayer, ViolationIntent, ViolationRule,
  SandboxViolation, FederatedSandboxViolation,
  ClassifierFn,
  CreateSandboxOptions,
} from './types.js';

// Resolution (pure)
export { resolveSandboxPolicy, validateSandboxConfigV2, classifyViolation } from './resolver.js';

// Backend interface
export type { SandboxBackend, SandboxBackendContext, SandboxHandle } from './backend.js';
export { SandboxBackendRegistry, defaultBackendRegistry } from './registry.js';

// High-level convenience
export { createSandbox } from './createSandbox.js';

// Bundled backends
export { NoneBackend } from './backends/none.js';
export { AnthropicBackend } from './backends/anthropic.js';
export { SandboxExecBackend } from './backends/sandbox-exec.js';
export { BubblewrapBackend } from './backends/bubblewrap.js';
// DockerBackend ships in v0.5

// Errors
export {
  SandboxError, UnsupportedPlatformError, MissingDependencyError,
  CredentialProxyMissingError, ResolutionError, SubprocessPolicyError,
} from './errors.js';

// IPC helper
export { TwoFileIpc } from './ipc.js';

// v1 compatibility
export { translateV1ToV2 } from './v1-translator.js';

// Versioning
export {
  SANDBOX_CONFIG_VERSION,
} from './v2.js';

export {
  SANDBOX_PROTOCOL_VERSION,
  SANDBOX_CLASSIFICATION_VERSION,
} from '../protocol/sandbox.js';
```

---

## Errors

```typescript
export abstract class SandboxError extends Error {
  abstract readonly code: string;
}

export class UnsupportedPlatformError extends SandboxError {
  readonly code = 'unsupported_platform';
  constructor(public backend: SandboxBackendId, public reason: string);
}

export class MissingDependencyError extends SandboxError {
  readonly code = 'missing_dependency';
  constructor(public backend: SandboxBackendId, public missing: string[]);
}

export class CredentialProxyMissingError extends SandboxError {
  readonly code = 'credential_proxy_missing';
  constructor(public reason: string);
}

export class ResolutionError extends SandboxError {
  readonly code = 'resolution';
  constructor(public field: string, public detail: string);
}

export class SubprocessPolicyError extends ResolutionError {
  readonly subErrorCode: 'narrow_violation' | 'no_parent_rule' | 'mode_more_permissive';
  constructor(
    public axis: 'filesystem' | 'network' | 'spawn' | 'limits' | 'mode',
    detail: string,
    subErrorCode: SubprocessPolicyError['subErrorCode'],
    public parentRule?: unknown,
    public attemptedRule?: unknown,
  );
}
```

---

## Threat model

What sandbox v2 *catches* under `enforce`:

| Scenario | Caught via |
|---|---|
| `rm -rf $HOME` from prompt injection | FS allowlist (no `$HOME` outside declared roots) |
| Hallucinated tool call exfilling to `attacker.com` | Net deny-default |
| Curl piped into shell installing a binary | Spawn allowlist |
| Reading `~/.aws/credentials` | FS denylist |
| 50GB process OOM'ing the host | `limits.memoryMb` (where backend supports) |
| Infinite loop burning compute for hours | `limits.maxDurationMinutes` |
| Leaked API key on a command line | Credential proxy (cred never on cmdline) |
| Compromised git: exfil via clone of attacker repo | Subprocess policy on git (v0.5+) |

What sandbox v2 **doesn't catch**:

- **Logical mistakes within allowed scope.** Permission-gated tool approval, not sandbox.
- **Data exfil through allowed channels.** Content-level DLP, out of scope.
- **Slow-burn agent behavior.** `maxDurationMinutes` is coarse mitigation only.
- **Compromised MCP server reading agent secrets** (v0.4 limitation). Per-tool sandboxing is v0.5+.
- **Sandbox escape via backend bug.** Mitigation is testing matrix and stronger backends.

### Strict-mode opt-in defaults

Hosted compute providers typically ship with `mode: 'strict'` and `credentials.failClosed: true` by default. Local backends default to `mode: 'none'`. Different threat models, different defaults. The package itself doesn't impose this — the consumer's environment composer does.

### Custom backends and trust

Anyone can implement `SandboxBackend`. A custom backend running in your process is trusted code. Mitigations: document this; strict-mode opt-out at consumer level; audit which backend ran each session.

---

## Open questions

1. **Marker namespace conventions.** Builtin markers are bare strings; custom markers might collide if multiple consumers use the same name. Recommend prefix convention (`acme/foo`); enforce in v0.5+ if collisions surface.
2. **`prepareImage()` retry semantics.** Backends may cache transient build failures briefly; consumers see promise rejection and decide. Documented per-backend.
3. **`SubprocessPolicy.match` ergonomics.** Today binaries match basename or absolute path; argv match is prefix-only. Regex/glob matching deferred until real use case appears.
4. **Classification taxonomy extensibility.** Custom classes use the `extraClassifiers` option; recommend prefix convention; treat as opaque strings on receivers that don't know them.
5. **MicroVM image format compatibility with Docker.** Firecracker uses a different rootfs format; build-bridge step required. Defer detailed design until v1.0.
6. **Default `audit.federation.mode`.** Currently `classified`. Could argue for `none` as the most-private default. Lean: keep `classified` — operationally useful for ops dashboards, classification is privacy-preserving by design.

---

## Cross-references

- [`architecture.md`](./architecture.md) — overall package architecture; sandbox v2 referenced as D10, nanoclaw as D16.
- [`repo-kind.md`](./repo-kind.md) — repo workspaces have multi-root semantics that inform `derive: sections` resolution.
- nanoclaw repository — reference implementation for `builtin/docker`. When that backend ships, the implementation doc cross-references `container/Dockerfile`, `src/container-runner.ts`, and `onecli.applyContainerConfig` directly.
- (TBD) `docs/design/sandbox-mcp-isolation.md` — v0.5+ design for per-tool MCP sandboxing, building on subprocess policy.
