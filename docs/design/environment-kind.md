---
status: draft
owner: alexngai
created: 2026-05-05
revised: 2026-05-05
---

# Environment Kind: Design and Public API

## Scope

This doc covers the **`environment` workspace kind** — the composer that holds multiple member workspaces (typically one or more `repo` kinds + one `task-run` kind) under a single policy umbrella with identity, inbox, tools, permissions, compute, secrets, and sandbox layers. Background and rationale are in [`architecture.md`](./architecture.md) (D4).

The package owns: the manifest format, provider interface, resolver, lockfile format, environment runtime object, CLI surface, and discovery rules. The package does not own: provider implementations beyond `builtin/*` (those ship in their own packages), policy enforcement at the consumer level, organizational manifest distribution, or fleet management.

The environment kind is what makes the package a coherent **agent execution substrate** — without it, the other kinds (`task-run`, `repo`) are just useful primitives. With it, agents have a portable, version-tagged, signable description of "everything I need to do my work."

---

## Naming convention

Same rule as [`repo-kind.md`](./repo-kind.md) and [`sandbox.md`](./sandbox.md):

| Surface | Convention |
|---|---|
| **In-memory TS types** | camelCase (`apiVersion`, `keychainService`, `denyDefault`) |
| **YAML manifests, JSON-RPC params, lockfile JSON** | snake_case (`api_version`, `keychain_service`, `deny_default`) |
| **Constants** | SCREAMING_SNAKE |

This is a load-bearing convention: every wire/file format in the package is snake_case; every TS type is camelCase. Translators in `agent-workspace/kinds/environment/wire.ts` bridge the two on read/write. Examples in this doc use snake_case in YAML blocks and camelCase in TS blocks consistently.

---

## What the environment kind means

An **environment** is a typed, version-tagged, portable description of everything an agent needs to be set up correctly: who it acts as, where it works, what tools and credentials it has access to, what's allowed and what's forbidden, where it runs.

The composer is **not** itself a workspace in the FS sense. It's a higher-order kind whose lifecycle drives the lifecycles of the workspaces it contains:

```
Environment (composer)
├── identity      → agent-iam handle
├── inbox         → agent-inbox handle
├── repos         → RepoManager with N attached repo workspaces
├── workspace     → WorkspaceManager (task-run kind) for ephemeral runs
├── tools         → MCP server registry + endpoints
├── permissions   → loadout / permission overlay
├── compute       → process execution target
├── secrets       → credential references (resolved on-demand)
└── sandbox       → SandboxHandle covering all of the above
```

Each layer is a typed slot. Each slot has a configured **provider** (the package that implements it) and **config** (provider-specific). The resolver instantiates each provider in dependency order; the result is an `Environment` runtime handle.

---

## Design principles

1. **Manifest is portable.** Same YAML works on any host with the providers installed. No machine-specific paths in the committed manifest.
2. **Layer set is closed.** Eight layer slots, fixed names. Adding a layer requires a manifest version bump.
3. **Provider names are namespaced.** `<package>/<impl-name>` + `builtin/*`. Avoids collisions when the registry grows.
4. **References resolve at activation, not write time.** Secrets, identities, channel refs are URIs; resolved when the environment activates so committed manifests carry no live values.
5. **Strict layer dependency order.** Resolver runs layers in topological order based on declared dependencies; rejects circular or undeclared dependencies.
6. **Pure resolver.** Manifest + provider registry → `ResolvedEnvironmentManifest` is a pure function. Activation is the side-effecting step.
7. **Lockfile pins both provider versions and resolved values.** Two consumers running the same lockfile observe the same environment.
8. **Per-machine overrides via `.local.yml` sidecar.** Mirrors sessionlog's `settings.local.json` pattern. Local overrides do not federate.
9. **Activation is reversible and inspectable.** `describe`, `activate`, `dispose` round-trip cleanly. State lives in `~/.config/agent-env/`, easy to nuke.
10. **Sandbox is just another layer.** Same provider/config shape as everything else. The fact that it's the policy umbrella is encoded in the dependency graph, not special-cased.

---

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| E1 | **Manifest is YAML primary, JSON supported, TOML refused** | YAML is the most-common config language for portable manifests; JSON for machine consumers; TOML adds dialect with no benefit. |
| E2 | **YAML/JSON uses snake_case throughout, including framing** | `api_version` not `apiVersion`. Breaks K8s convention but stays consistent with the package's wire-format rule. Translators bridge to camelCase TS. |
| E3 | **No `kind:` field in manifest** | Today the only kind is "Environment"; the slot adds noise without payoff. Reintroduce when a second kind (e.g., `EnvironmentTemplate`) genuinely lands. |
| E4 | **Closed layer set** | Nine layers: `identity`, `secrets`, `inbox`, `compute`, `workspace`, `repos`, `tools`, `permissions`, `sandbox`. Adding/removing requires a manifest version bump. |
| E5 | **Provider names: `<package>/<impl>` + `builtin/*`** | Namespaced to avoid registry collisions. |
| E6 | **References use URI schemes** | `vault://`, `env://`, `file://`, `agent-iam://`, etc. Resolver consults a registry of URI handlers (closed builtin set + per-call custom). |
| E7 | **Layer dependencies declared by providers** | Each provider declares `dependsOn: EnvironmentLayer[]`. Resolver topologically sorts. |
| E8 | **Composition order: defaults → extends → main → local** | `extends` chain merges left-to-right (later overrides earlier); main overrides extends; `<name>.local.yml` overrides main. |
| E9 | **`extends:` paths only in v0.4** | URL-based extends invites remote-fetch attack surface. Paths only initially; HTTPS extends with explicit allow-list is v0.5+. |
| E10 | **Lockfile is JSON, gitignored by default** | Pretty-printed JSON for machine consumption + diffability; gitignored because it contains resolved values that may be host-specific. |
| E11 | **CLI is a separate optional package** | `@agent-workspace/cli` ships as a separate npm package so library users don't pull in CLI deps. |
| E12 | **Activation exports both manifest path and flat env vars** | Tools that speak manifest read `AGENT_ENV_MANIFEST`; tools that don't read flat exports namespaced as `AGENT_ENV_<LAYER>_<KEY>`. |
| E13 | **Three discovery modes for active manifest** | `AGENT_ENV_MANIFEST` env var (explicit) > `.agent-env.yml` walkup from cwd (project-rooted) > `~/.config/agent-env/active.yml` symlink (user default). |
| E14 | **Provider versions are semver; lockfile pins exact** | Manifest declares `provider: agent-iam@^0.4`; lockfile pins `agent-iam@0.4.2`. Within-semver-compat drift warns; outside-compat errors unless `--update-lock`. |
| E15 | **Per-session overrides keyed on session metadata** | Sandbox can have `default` + `overrides` with `when:` clauses. Composes with the existing session-resource concept in consumer hubs. |
| E16 | **`builtin/*` providers are part of the package's main module** | Audited together; not pluggable. Custom providers are clearly distinguished. |
| E17 | **Environment is generic over its layer types** | `Environment<TLayers>` typed via consumer-supplied layer types; default `DefaultLayers` for ergonomic untyped usage. |
| E18 | **`metadata.name` is display-only; manifest path is canonical** | Two manifests can both declare `name: dev`; CLI/programmatic identifier is the path. |
| E19 | **Strict mode declarable in manifest AND at resolver call site** | `metadata.strict: true` in manifest; `options.strict: true` at call site. Effective = `manifest || options` (more restrictive wins). |
| E20 | **High-level `createEnvironment()` orchestrates load → validate → resolve** | Steady-state convenience. Lower-level pieces stay exported for advanced use. |
| E21 | **Typed `ResolveContext.resolved` accessor** | `ctx.resolved.get<T>(layer)` (throws if missing) / `tryGet<T>(layer)` (returns undefined). Type-safe via consumer-supplied generic. |
| E22 | **Every layer has a default; "required" status removed** | Resolver auto-fills omitted layers with their default builtin provider + provider-declared default config. Minimal manifest (just `api_version` + `metadata.name`) resolves to a working environment. Strict mode rejects implicit defaults. |
| E23 | **`defineProvider()` helper for ergonomic provider authoring** | Required fields enforced at type level; 9 optional methods get safe defaults. Validates name format (`<package>/<impl>`) and semver at construction. Cuts boilerplate by ~70% for typical providers. |
| E24 | **`Provider.defaultConfig?(): TConfig`** | Providers declare the default config used when manifest omits the layer entry. Defaults to `() => ({})`. |
| E25 | **Strict is monotonic upward across extends chain** | Once any manifest in the chain declares `strict: true`, the resolved manifest is strict. Children cannot downgrade. Resolver emits warning on attempted downgrade. |
| E26 | **`parseApiVersion(input)` helper** | Explicit parser for `agent-environment/v1` strings; throws `InvalidApiVersionError`. Used by resolver validation. |
| E27 | **`extends:` paths relative to declaring manifest** | Each manifest's `extends:` resolves paths against its own directory, not cwd or root manifest. Standard include-style behavior. |
| E28 | **`provider.snapshotForLockfile?(handle): unknown`** | Provider-controlled lockfile contribution. Defaults to `describe(handle).detail`. **Must not include secrets** — documented contract. |
| E29 | **`parseEnvironmentManifest(yaml, opts?)`** | In-memory companion to `loadEnvironmentManifest`. `virtualPath` lets `extends:` resolve against a fake location for tests. |
| E30 | **URI handlers receive `AbortSignal`** | `UriHandlerContext.abortSignal` so handlers can cancel hung requests. Resolver controls timeout via `ResolveEnvironmentOptions.uriResolveTimeoutMs` (default 30s). |

---

## Manifest format

### Top level

```yaml
api_version: agent-environment/v1
metadata:
  name: openhive-dev
  description: "Working on openhive across two repos"
  labels: { team: platform, role: dev }
  strict: false                     # optional; opt into strict resolution

extends:
  - ./team-defaults.yml
  - ../shared-permissions.yml

layers:
  identity:    { ... }
  secrets:     { ... }
  inbox:       { ... }
  compute:     { ... }
  workspace:   { ... }
  repos:       { ... }
  tools:       { ... }
  permissions: { ... }
  sandbox:     { ... }
```

`api_version: agent-environment/v1` is the schema version. Bumped only on breaking schema changes.

`metadata.name` is a **display label**. Two manifests can have the same name; the canonical identifier is the manifest's path. CLI commands accept either (`agent-env activate <name|path>`); programmatic API takes the path.

`metadata.strict: true` opts the manifest into strict resolution at the manifest level — even if a permissive caller forgets to pass `options.strict: true`, the manifest still enforces. Effective strict = `manifest.strict || options.strict`.

`extends` lists path-relative parent manifests; merged left-to-right. `api_version` must match across the extends chain.

### Layer entry shape

Each layer is:

```yaml
<layer_name>:
  provider: <package-name>/<impl-name>     # or 'builtin/<impl>'
  version: ^0.4                              # optional; semver range
  config:
    # provider-specific (snake_case in YAML)
```

`provider` selects the implementation. `version` is the semver range the provider must satisfy; the lockfile pins exact. `config` is opaque to the resolver — passed verbatim to the provider's `validateConfig`.

### Full example

```yaml
api_version: agent-environment/v1
metadata:
  name: example-dev

layers:
  identity:
    provider: agent-iam/local
    config:
      ref: alex@personal
      keychain_service: agent-environment

  secrets:
    provider: builtin/secret-refs
    config:
      vaults:
        - { kind: keychain, service: agent-environment }

  inbox:
    provider: agent-inbox/local
    config:
      channels: [primary, dispatch]

  compute:
    provider: builtin/local
    config: {}

  workspace:
    provider: agent-workspace/kinds/task-run
    config:
      base_dir: ~/runs
      additional_dirs: [logs]

  repos:
    provider: agent-workspace/kinds/repo
    config:
      declare:
        - { remote_url: https://github.com/foo/bar, local_path: ~/code/bar, visibility: hub_local }
        - { remote_url: https://github.com/foo/baz, local_path: ~/code/baz, visibility: federated }

  tools:
    provider: builtin/mcp
    config:
      servers:
        - { name: git-mcp, command: git-mcp-server, args: [] }
        - { name: fs-mcp,  command: fs-mcp-server,  args: ['--root', '/workspace'] }

  permissions:
    provider: example/loadout       # consumer-shipped provider
    config:
      ref: example://loadouts/chat-agent

  sandbox:
    provider: builtin/anthropic
    config:
      mode: enforce
      filesystem:
        allow:
          - { derive: sections }
          - { paths: ['/etc/ssl/certs'] }
        deny:
          - { paths: ['~/.ssh', '~/.aws', '~/.gnupg'] }
      network:
        allow:
          - { derive: tools }
          - { derive: inbox }
          - { hosts: ['github.com:443', 'api.anthropic.com:443'] }
        deny_default: true
      limits:
        memory_mb: 2048
        max_duration_minutes: 60
      audit:
        log_violations: true
        federation: { mode: classified }
      credentials:
        proxy: { provider: builtin/proxy, config: {} }
        fail_closed: true
```

Notes:
- All YAML field names are snake_case (`api_version`, `keychain_service`, `base_dir`, `deny_default`, `memory_mb`, `log_violations`, `fail_closed`).
- The `permissions` layer uses a consumer-shipped provider (`example/loadout`) and a custom URI scheme (`example://`) — both are extensions; the package has no opinion.

### Per-machine overrides (`<name>.local.yml`)

Sidecar manifest, gitignored. Same shape as the main manifest; deep-merged on load. Local wins.

```yaml
# example-dev.local.yml
api_version: agent-environment/v1
metadata: { name: example-dev }
layers:
  repos:
    config:
      declare:
        - { remote_url: ..., local_path: /Users/alice/code/bar }   # path is local
  identity:
    config: { keychain_service: alice-keychain }
```

### Merge semantics

| Type | Behavior |
|---|---|
| Plain object | Deep merge; later overrides earlier |
| Array of objects with `merge_key` | Match by key; matched entries deep-merged; unmatched concat |
| Array of objects without `merge_key` | Replace wholesale |
| Scalar / primitive | Replace |

`merge_key` is declared per-provider via `Provider.mergeKey?(layer): string`. Builtins:

| Layer/field | merge_key |
|---|---|
| `repos.config.declare` | `remote_url` |
| `tools.config.servers` | `name` |
| `secrets.config.vaults` | `kind` (or composite) |
| `sandbox.config.subprocess_policy` | `match.binaries` (joined) |

Within a layer's `config`, the provider's `mergeConfig` runs after the resolver's structural merge — providers can override array merging or apply additional rules.

---

## Layers

**Every layer has a default provider and default config (E22).** Manifests can omit any layer; the resolver auto-fills with the default. Strict mode (E19, E25) rejects implicit defaults — every layer must be explicitly declared in strict.

| Layer | Purpose | Default provider | Default config | dependsOn |
|---|---|---|---|---|
| `identity` | Who is this agent? | `builtin/identity-static` | `{ ref: 'anonymous-local' }` | (none — root) |
| `secrets` | Credential references | `builtin/secret-refs` | `{ vaults: [] }` | `[identity]` |
| `inbox` | Messaging | `builtin/inbox-noop` | `{}` | `[identity]` |
| `compute` | Where it runs | `builtin/local` | `{}` | `[identity, secrets]` |
| `workspace` | Task-run scratch dir | `agent-workspace/kinds/task-run` | `{ baseDir: os.tmpdir() }` | `[compute]` |
| `repos` | Codebase context | `agent-workspace/kinds/repo` | `{ declare: [] }` | `[identity, workspace]` |
| `tools` | MCP servers | `builtin/mcp` | `{ servers: [] }` | `[identity, secrets]` |
| `permissions` | Allowed tool calls | `builtin/permissions-permissive` | `{}` | `[identity]` |
| `sandbox` | Policy enforcement | `builtin/none` | `{ mode: 'none' }` | `[workspace, repos, tools, inbox, secrets]` |

Topological order from deps: `identity → secrets, permissions → inbox → compute → workspace → repos, tools → sandbox`.

Sandbox depends on most other layers because its `derive:` markers reference workspace sections, tool endpoints, inbox host:port, and credentials. The resolver enforces this order.

The default `builtin/identity-static` is suitable only for **dev/test** — its anonymous identity allows any operation. Production manifests should use a real identity provider (`agent-iam/oauth`, etc.) and declare `strict: true` so omitting identity fails loudly. `agent-env doctor` warns when identity is `builtin/identity-static`.

### Minimal manifest

A manifest with just framing resolves to a working environment via defaults:

```yaml
api_version: agent-environment/v1
metadata: { name: minimal }
```

Useful for tests, demos, CI, and ephemeral throwaways. Inappropriate for anything that touches secrets or production data.

### Layer slot constraints

Closed set; the resolver rejects manifests with unknown layer names. Adding a layer = manifest `api_version` bump.

---

## Provider interface

```typescript
// agent-workspace/kinds/environment/provider.ts

export type EnvironmentLayer =
  | 'identity' | 'secrets' | 'inbox' | 'compute'
  | 'workspace' | 'repos' | 'tools' | 'permissions' | 'sandbox';

export interface Provider<TConfig = unknown, THandle = unknown> {
  readonly name: string;                        // 'agent-iam/local', 'builtin/local', ...
  readonly version: string;                     // semver
  readonly layer: EnvironmentLayer;
  readonly dependsOn: readonly EnvironmentLayer[];

  /** Validate and normalize raw config into a typed shape. Throws on invalid (parse-style). */
  validateConfig(raw: unknown): TConfig;

  /** Resolve the provider — instantiate handles, contact services, etc. */
  resolve(config: TConfig, ctx: ResolveContext): Promise<THandle>;

  // ── Optional: resolver hooks ───────────────────────────────────────────

  /** Default config used when the manifest omits this layer entirely. Defaults to `() => ({})`. */
  defaultConfig?(): TConfig;

  /** Deep-merge local override into base. Falls back to `defaultMergeConfig` if absent. */
  mergeConfig?(base: TConfig, local: Partial<TConfig>): TConfig;

  /** Declare merge_key for arrays-of-objects in config (e.g., `'remote_url'` for `repos.declare`). */
  mergeKey?(path: string): string | undefined;

  /** Extract URIs the resolver should pre-validate against registered schemes. */
  extractUris?(config: TConfig): string[];

  /** Extract dependent layers from config (e.g., sandbox `derive:` markers). */
  extractDependentLayers?(config: TConfig): EnvironmentLayer[];

  // ── Optional: lifecycle / observability ────────────────────────────────

  /** Human-readable summary of the resolved handle (for `agent-env describe`). */
  describe?(handle: THandle): LayerSummary;

  /** Clean up resources. Called on environment dispose. */
  dispose?(handle: THandle): Promise<void>;

  /** Validate that the resolved handle is still healthy. */
  inspect?(handle: THandle): Promise<{ healthy: boolean; messages: string[] }>;

  /** Contribute flat env-var exports for activation (auto-prefixed by activation step). */
  exports?(handle: THandle): Record<string, string>;

  /** Generate the lockfile snapshot. **MUST NOT include secrets.**
   *  Defaults to `describe(handle).detail` if absent. See E28 + threat model. */
  snapshotForLockfile?(handle: THandle): unknown;
}

export interface ResolveContext {
  manifest: ResolvedEnvironmentManifest;
  resolved: ResolvedLayers;             // typed accessor; see below
  hostInfo: HostInfo;
  resolveUri: (uri: string) => Promise<unknown>;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/** Typed accessor for already-resolved layers. */
export interface ResolvedLayers {
  /** Get a resolved layer. Throws `MissingResolvedLayerError` if the layer is not
   *  yet resolved (e.g., not in the calling provider's `dependsOn`). */
  get<T>(layer: EnvironmentLayer): T;
  /** Get a resolved layer or undefined if not present. Never throws. */
  tryGet<T>(layer: EnvironmentLayer): T | undefined;
  /** Check whether a layer has been resolved. */
  has(layer: EnvironmentLayer): boolean;
}

export interface HostInfo {
  os: string;
  arch: string;
  hostname: string;
  cwd: string;
}

export interface LayerSummary {
  short: string;                       // one-line for `describe`
  detail: Record<string, unknown>;     // structured for `--json`
}
```

Provider packages implement `Provider` and export the instance. Consumers register them with a `ProviderRegistry`.

### `dependsOn` and resolution order

Each provider declares which layers it depends on. Resolver:

1. Walks the manifest's layer entries.
2. Looks up each provider in the registry.
3. Topologically sorts by the `dependsOn` graph (rejecting cycles).
4. Resolves layers in order; each `resolve()` call sees the already-resolved layers via `ctx.resolved.get<T>(layer)`.

A provider that depends on a layer the manifest didn't declare produces a `MissingLayerError` at validation time. Circular dependencies produce `CircularDependencyError`.

### Validate vs collect convention

`validateConfig` is provider-side and **throws** on invalid (parse-style). The resolver-level `validateEnvironmentManifest` aggregates all provider errors into a non-throwing `{ valid, errors }` result. Consistent with `validateOutput` and `validateSandboxConfigV2`.

### Default merge behavior

```typescript
export function defaultMergeConfig<T>(base: T, local: Partial<T>): T;
```

Recursive deep merge for plain objects; replace for everything else. Providers without their own `mergeConfig` inherit this. Documented in the API.

### `defineProvider()` — provider authoring helper (E23)

The `Provider` interface has 5 required fields and 9 optional methods. Implementing every optional is hostile; forgetting one silently changes behavior. `defineProvider()` enforces required fields at the type level and fills in safe defaults for everything else.

```typescript
type ProviderRequired<TConfig, THandle> = Pick<
  Provider<TConfig, THandle>,
  'name' | 'version' | 'layer' | 'dependsOn' | 'validateConfig' | 'resolve'
>;

type ProviderOptional<TConfig, THandle> = Partial<
  Omit<Provider<TConfig, THandle>, keyof ProviderRequired<TConfig, THandle>>
>;

export function defineProvider<TConfig, THandle>(
  spec: ProviderRequired<TConfig, THandle> & ProviderOptional<TConfig, THandle>,
): Provider<TConfig, THandle>;
```

#### Defaults applied if absent

| Method | Default behavior |
|---|---|
| `defaultConfig` | `() => ({})` (empty config) |
| `mergeConfig` | `defaultMergeConfig` (deep-merge objects, replace primitives, replace arrays unless `mergeKey` declared) |
| `mergeKey` | `() => undefined` (no array-by-key merging) |
| `extractUris` | `() => []` (no URI pre-validation contributions) |
| `extractDependentLayers` | `() => []` (only `dependsOn` is checked) |
| `describe` | `(handle) => ({ short: name, detail: {} })` |
| `dispose` | `async () => {}` (no-op) |
| `inspect` | `async () => ({ healthy: true, messages: [] })` |
| `exports` | `() => ({})` |
| `snapshotForLockfile` | `(handle) => describe(handle).detail` (re-uses `describe`; safe by virtue of describe not including secrets) |

The constructed provider records which optionals were explicitly provided vs defaulted, so `agent-env doctor` can flag layers using defaulted `inspect` (which always reports healthy) distinctly from real implementations.

#### Validation at construction time

- **`name`** must match `^[a-z0-9-]+(\/[a-z0-9-]+)+$` (e.g., `builtin/none`, `agent-iam/local`). The `builtin/` prefix is reserved — `defineProvider()` accepts it but the registry rejects external `builtin/*` registration (only `defaultProviderRegistry` accepts `builtin/*`). Throw `InvalidProviderNameError`.
- **`version`** must parse as semver. Throw `InvalidProviderVersionError`.
- **`layer`** must be a valid `EnvironmentLayer`. Throw `UnknownLayerError`.
- **`dependsOn`** must contain only valid layers and must not include `layer` itself (self-dependency). Throw `CircularDependencyError`.

#### Caller experience

Minimal provider — required fields only:

```typescript
export const myIdentityProvider = defineProvider<MyConfig, MyHandle>({
  name: 'agent-iam/local',
  version: '0.4.0',
  layer: 'identity',
  dependsOn: [],
  validateConfig: (raw) => MyConfigSchema.parse(raw),
  resolve: async (config, ctx) => new MyIdentityHandle(config),
});
```

Six lines. Anything more is opt-in.

Provider with selected extras:

```typescript
export const sandboxProvider = defineProvider<SandboxConfigV2, SandboxHandle>({
  name: 'builtin/anthropic',
  version: '0.4.0',
  layer: 'sandbox',
  dependsOn: ['workspace', 'repos', 'tools', 'inbox', 'secrets'],
  validateConfig: (raw) => parseAndValidateSandbox(raw),
  resolve: async (config, ctx) => initializeAnthropicSandbox(config, ctx),
  extractDependentLayers: (config) => extractDeriveMarkers(config),
  describe: (handle) => ({
    short: `mode=${handle.mode}, rules=${handle.policy.filesystem.allow.length}`,
    detail: { policy: handle.policy },
  }),
  dispose: (handle) => handle.destroy(),
});
```

### Builtin providers shipped in the package

| Provider | Layer | Purpose |
|---|---|---|
| `builtin/identity-static` | identity | Static identity from config (no auth) |
| `builtin/secret-refs` | secrets | URI-resolver registry; default `vault://`, `env://`, `file://` |
| `builtin/inbox-noop` | inbox | No-op inbox (offline/test) |
| `builtin/local` | compute | Local host process |
| `builtin/mcp` | tools | MCP server registry |
| `builtin/permissions-permissive` | permissions | Allow-all (no enforcement) |
| `builtin/none` | sandbox | No sandbox |
| `builtin/anthropic`, `sandbox-exec`, `bubblewrap` | sandbox | Real sandbox backends |
| `agent-workspace/kinds/task-run` | workspace | Re-export of task-run kind |
| `agent-workspace/kinds/repo` | repos | Re-export of repo kind |

---

## URI references

References resolve via a closed builtin set plus per-call custom registrations. Same pattern as sandbox `custom` markers.

### Builtin URI schemes

| Scheme | Resolves to | Example |
|---|---|---|
| `env://` | Environment variable value (string) | `env://OPENAI_API_KEY` |
| `file://` | File contents (string, utf8) | `file:///etc/some-config.json` |
| `vault://` | Secrets vault entry (per-vault shape) | `vault://service/keychain/api-token` |

### Custom URI schemes

```typescript
export type UriHandler<T = unknown> = (uri: string, ctx: UriHandlerContext) => Promise<T>;

export interface UriHandlerContext {
  manifest: ResolvedEnvironmentManifest;
  hostInfo: HostInfo;
  /** Cancelled when the resolver's `uriResolveTimeoutMs` elapses or the call is aborted. */
  abortSignal: AbortSignal;
  // No `resolved` — handlers can run during resolve, before all layers are done.
}

export interface UriHandlers {
  [scheme: string]: UriHandler;
}
```

Consumers register their own (`agent-iam://`, `example://`) before calling `createEnvironment` / `resolveEnvironment`. Unknown schemes throw `UnknownUriSchemeError`. Handlers that fail surface as `UriResolutionError` with `scheme`, `uri`, and `cause`.

### Timeout

The resolver controls a global per-URI timeout via `ResolveEnvironmentOptions.uriResolveTimeoutMs` (default 30s). Each `UriHandler` invocation gets an `AbortSignal` that fires when the timeout elapses; handlers should wire this through to their underlying I/O (fetch, etc.). Handlers that ignore the signal can hang indefinitely — flag in provider-authoring docs.

### Pre-resolve URI validation

If a provider implements `extractUris(config)`, the resolver collects all URIs across the manifest at validation time and checks each scheme is in builtins or registered customs. Surfaces `UnknownUriSchemeError` early instead of at resolve time. Providers without `extractUris` discover URI errors at resolve time (current behavior).

---

## Resolver

```typescript
// agent-workspace/kinds/environment/resolver.ts

export interface ResolvedEnvironmentManifest {
  apiVersion: 'agent-environment/v1';
  metadata: {
    name: string;
    description?: string;
    labels?: Record<string, string>;
    strict: boolean;            // resolved from manifest's metadata.strict || false
  };
  layers: Partial<Record<EnvironmentLayer, ResolvedLayerEntry>>;
  /** Non-resolved sources, for lockfile bookkeeping. */
  sourceManifestPath: string;
  extendsChain: string[];
  hasLocalOverrides: boolean;
}

export interface ResolvedLayerEntry {
  provider: string;
  resolvedVersion: string;     // exact, not semver range
  config: unknown;
}

/** Parse `agent-environment/v1` strings. Throws InvalidApiVersionError on malformed input. */
export function parseApiVersion(input: string): { kind: string; version: string };

/** Load from disk: read file, parse, walk extends chain, merge with local override. */
export async function loadEnvironmentManifest(
  manifestPath: string,
): Promise<ResolvedEnvironmentManifest>;

/** In-memory companion: parse a YAML string with optional virtual path for `extends:` resolution. */
export async function parseEnvironmentManifest(
  yaml: string,
  options?: { virtualPath?: string },
): Promise<ResolvedEnvironmentManifest>;

export function validateEnvironmentManifest(
  manifest: ResolvedEnvironmentManifest,
  registry: ProviderRegistry,
  uriHandlers?: UriHandlers,
): ManifestValidationResult;

export async function resolveEnvironment(
  manifest: ResolvedEnvironmentManifest,
  options: ResolveEnvironmentOptions,
): Promise<Environment>;

export interface ResolveEnvironmentOptions {
  registry: ProviderRegistry;
  uriHandlers?: UriHandlers;
  sessionMetadata?: Record<string, string>;
  strict?: boolean;
  errorMode?: 'fail-fast' | 'aggregate';        // default 'fail-fast'
  uriResolveTimeoutMs?: number;                 // default 30_000
  onWarning?: (w: ResolveWarning) => void;
}

export interface ResolveWarning {
  kind:
    | 'lockfile-drift'
    | 'unsupported-mode'
    | 'unsupported-limit'
    | 'discovery-conflict'
    | 'strict-downgrade-rejected'
    | 'identity-anonymous-default'
    | string;
  detail: string;
  layer?: EnvironmentLayer;
}
```

Resolution flow:

```
loadEnvironmentManifest(path)            // or parseEnvironmentManifest(yaml, opts)
  → parse YAML/JSON
  → parseApiVersion(api_version) — validate kind=agent-environment, version=v1
  → walk extends chain (paths only in v0.4); detect cycles → CircularExtendsError
  → merge: defaults → extends → main → local
  → resolve metadata.strict via monotonic-upward rule (E25):
      manifest.strict = ANY(strict in chain) — child cannot downgrade
      attempted downgrade emits 'strict-downgrade-rejected' warning
  → apply layer defaults (E22):
      for each layer not declared:
        if NOT strict → fill with default provider + provider.defaultConfig()
        if strict → throw MissingLayerError
  → returns ResolvedEnvironmentManifest

validateEnvironmentManifest(manifest, registry, uriHandlers)
  → check api_version supported
  → check layer slots are valid (closed set)
  → resolve providers from registry; check semver
  → topo-sort by dependsOn; reject cycles
  → check cross-layer dependencies (extractDependentLayers)
  → check URIs (extractUris) against builtin + custom schemes
  → run each provider.validateConfig
  → aggregate errors, return { valid, errors }

resolveEnvironment(manifest, options)
  → validate first (always); if invalid, throw ProviderResolutionError with details
  → effectiveStrict = manifest.metadata.strict || options.strict
  → for each layer in topo order (parallel where DAG permits):
       provider.resolve(config, ctx)
       attach handle to environment
       on error: if errorMode='fail-fast', throw; else collect
  → return Environment
```

### High-level convenience

```typescript
export async function createEnvironment(
  manifestPath: string,
  options?: Omit<ResolveEnvironmentOptions, 'registry'> & {
    registry?: ProviderRegistry;
  },
): Promise<Environment>;
```

Internally: `loadEnvironmentManifest` → `resolveEnvironment` (which validates internally). Uses `defaultProviderRegistry` if no registry passed. Steady-state usage:

```typescript
const env = await createEnvironment('~/.config/agent-env/manifests/dev.yml');
const repo = env.repos.find(canonicalUrl, localPath);
const sandbox = env.sandbox;
// ...
await env.dispose();
```

Lower-level pieces (`loadEnvironmentManifest`, `validateEnvironmentManifest`, `resolveEnvironment`) stay exported for advanced use.

---

## Environment runtime

```typescript
// agent-workspace/kinds/environment/runtime.ts

export interface DefaultLayers {
  identity: unknown;
  secrets: unknown;
  inbox: unknown;
  compute: unknown;
  workspace: unknown;
  repos: unknown;
  tools: unknown;
  permissions: unknown;
  sandbox: unknown;
}

export interface Environment<TLayers extends DefaultLayers = DefaultLayers> {
  readonly manifest: ResolvedEnvironmentManifest;
  readonly identity:    TLayers['identity'];
  readonly secrets:     TLayers['secrets'];
  readonly inbox:       TLayers['inbox'];
  readonly compute:     TLayers['compute'];
  readonly workspace:   TLayers['workspace'];
  readonly repos:       TLayers['repos'];
  readonly tools:       TLayers['tools'];
  readonly permissions: TLayers['permissions'];
  readonly sandbox:     TLayers['sandbox'];

  describe(): EnvironmentSummary;
  inspect(): Promise<EnvironmentHealth>;
  reload(): Promise<Environment<TLayers>>;
  dispose(): Promise<DisposeResult>;
}

export interface EnvironmentSummary {
  manifest: { name: string; apiVersion: string; sourcePath: string; strict: boolean };
  layers: Record<EnvironmentLayer, LayerSummary>;
  resolvedAt: string;
}

export interface EnvironmentHealth {
  healthy: boolean;
  layers: Record<EnvironmentLayer, { healthy: boolean; messages: string[] }>;
}

export interface DisposeResult {
  disposedLayers: number;
  errors: DisposeError[];
}

export interface DisposeError {
  layer: EnvironmentLayer;
  cause: Error;
}

/** Helper: reload + dispose-old in a single safe call. */
export async function reloadEnvironment<T extends DefaultLayers>(
  env: Environment<T>,
): Promise<Environment<T>>;
```

Consumers narrow `TLayers` to their concrete provider types:

```typescript
import type { IdentityHandle } from 'agent-iam';
import type { RepoManager } from 'agent-workspace/kinds/repo';
import type { SandboxHandle } from 'agent-workspace/sandbox';

interface MyLayers extends DefaultLayers {
  identity: IdentityHandle;
  repos:    RepoManager;
  sandbox:  SandboxHandle;
  // ...
}

const env = (await createEnvironment(path)) as Environment<MyLayers>;
const handle = env.repos.find(canonicalUrl, localPath);  // typed
```

For untyped use, `Environment` defaults to `DefaultLayers` (all `unknown`).

### `inspect()` runs in parallel

All layers' `provider.inspect()` calls execute via `Promise.allSettled`; one failure doesn't kill the rest. Total time is dominated by the slowest layer rather than the sum.

### `dispose()` returns errors

Reverse-topological order (sandbox first, identity last). Errors during dispose are collected into `DisposeResult.errors` rather than thrown. Caller decides what to do with them.

### `reload()` returns new instance

Old must be disposed by the caller. Easy footgun. Use `reloadEnvironment(env)` helper for the safe path.

---

## Activation and discovery

### Discovery (which manifest is active?)

Three modes, in priority order:

1. **`AGENT_ENV_MANIFEST=/path/to/manifest.yml`** env var (explicit). Relative paths resolve against `cwd`.
2. **`.agent-env.yml`** walking up from `cwd` (project-rooted; respects extends chain).
3. **`~/.config/agent-env/active.yml`** symlink (user default).

If none of the three resolve, `discoverActiveManifest()` returns `null`.

**Discovery conflict warning.** If a user runs `agent-env activate prod` and then `cd`s into a project with `.agent-env.yml`, the project wins. The CLI emits a warning ("project manifest overrides active.yml; pass --ignore-project-manifest to use active.yml") so users know what's happening.

### Activation

`agent-env activate <name|path>` (CLI) or `activateEnvironment(nameOrPath)` (programmatic):

1. Looks up the manifest (path direct, or `~/.config/agent-env/manifests/<name>.yml`).
2. Updates the symlink `~/.config/agent-env/active.yml → <manifest-path>`.
3. Optionally writes `~/.config/agent-env/active.env` with **flat env var exports**:

```bash
AGENT_ENV_NAME=example-dev
AGENT_ENV_MANIFEST=/Users/alex/.config/agent-env/manifests/example-dev.yml

# Layer-namespaced exports for tools that don't speak manifest
AGENT_ENV_IDENTITY_REF=alex@personal
AGENT_ENV_REPOS_PRIMARY_URL=https://github.com/foo/bar
AGENT_ENV_REPOS_PRIMARY_PATH=/Users/alex/code/bar
AGENT_ENV_INBOX_PRIMARY_HOST=...
```

Layer providers opt into flat exports via `provider.exports?(handle): Record<string, string>`. The activation step **prefixes every key with `AGENT_ENV_<LAYER>_`** to avoid cross-provider collisions. Consumers source `~/.config/agent-env/active.env` in their shell init or in-process via `loadActiveEnvExports()`.

This is the bridge to existing tools: cc-swarm, macro-agent, and any consumer's swarm-spawn flow read the env vars they care about. They don't have to know about `agent-environment` to benefit.

### Per-session overrides

Sandbox specifically supports per-session overrides keyed on session metadata (cf. [sandbox.md](./sandbox.md)):

```yaml
sandbox:
  provider: builtin/anthropic
  config:
    default:
      mode: enforce
    overrides:
      - when: { session_kind: dispatch }
        mode: strict
        network: { deny_default: true }
      - when: { session_kind: ci }
        mode: strict
        limits: { max_duration_minutes: 15 }
```

Override matching: `when` clauses use exact-match on session metadata fields. First match wins (top-down).

Session metadata is supplied at activation time:

```typescript
const env = await createEnvironment(path, {
  sessionMetadata: { session_kind: 'dispatch', initiator: 'admin' },
});
```

In v0.4, only sandbox supports the `default + overrides` shape. Other layers can opt in via `provider.resolveOverrides?(config, sessionMetadata): TConfig` in v0.5+.

---

## Lockfile

### Format

```json
{
  "api_version": "agent-environment-lock/v1",
  "manifest_hash": "sha256:abc123...",
  "manifest_path": "/Users/alex/.config/agent-env/manifests/example-dev.yml",
  "resolved_at": "2026-05-05T12:00:00Z",
  "host": { "os": "darwin", "arch": "arm64" },
  "layers": {
    "identity": {
      "provider": "agent-iam/local",
      "resolved_version": "0.4.2",
      "snapshot": { "ref": "alex@personal" }
    },
    "repos": {
      "provider": "agent-workspace/kinds/repo",
      "resolved_version": "0.4.0",
      "snapshot": {
        "resolved_canonical_urls": [
          "https://github.com/foo/bar",
          "https://github.com/foo/baz"
        ]
      }
    },
    "sandbox": {
      "provider": "builtin/anthropic",
      "resolved_version": "0.4.0",
      "snapshot": { "mode_resolved": "enforce", "rule_count": 12 }
    }
  }
}
```

JSON, snake_case, pretty-printed, gitignored by default. `manifest_hash` ties it to the source manifest **including local overrides** (so per-machine state is captured). Changes invalidate the lock.

### Version drift behavior

| Drift | Behavior |
|---|---|
| Within semver-compat (`0.4.2` → `0.4.3`) | Allow with warning ("lockfile pinned 0.4.2, installed 0.4.3"); update lockfile on next `agent-env lock`. |
| Outside semver-compat (`0.4.x` → `0.5.0`) | Error unless `--update-lock` passed. |
| Manifest hash mismatch | Stale lockfile; resolver warns at activation, regenerates. Caller can `agent-env lock` explicitly to acknowledge. |
| Host info mismatch (laptop switch) | Informational only; warn but don't block. |

### When to lock

- `agent-env lock` (CLI) explicit.
- `agent-env activate` writes the lockfile as a side effect.
- Programmatic: `lockEnvironment(env)` returns a `LockfileV1` object.

### Why lock

Without a lockfile, `agent-env describe` on Tuesday and Wednesday could give different answers because:
- A referenced URI (vault entry, identity ref) changed underneath.
- A provider got a patch update that changes resolved values.

Locking pins both, giving deterministic activation.

---

## CLI

> **Note:** Commands below ship in `@agent-workspace/cli`, a separate optional package. The main `agent-workspace` library does not ship a CLI.

```
agent-env init [--from <preset>]      # scaffold ~/.config/agent-env/manifests/<name>.yml
agent-env list                        # list known environments
agent-env describe [name|path]        # resolve + summarize all layers
agent-env activate <name|path>        # symlink + flat env exports
agent-env doctor [name|path]          # validate manifest + provider availability + URI handlers
agent-env diff <a> <b>                # structural diff between two manifests
agent-env lock [name|path]            # regenerate lockfile
agent-env switch                      # interactive picker (TTY required; errors otherwise)
agent-env reload                      # re-resolve active environment
agent-env dispose                     # tear down active environment
```

Presets bundled with the CLI live under `@agent-workspace/cli/presets/{dev,production,minimal}`; user-registered presets at `~/.config/agent-env/presets/<name>.yml`. `agent-env init --from <preset>` searches both.

### Sample output

`describe`:

```
$ agent-env describe example-dev

Environment: example-dev
Manifest:    ~/.config/agent-env/manifests/example-dev.yml
Resolved:    2026-05-05T12:00:00Z
Strict:      false

Layers:
  identity     agent-iam/local@0.4.2     ref=alex@personal
  secrets      builtin/secret-refs@0.4.0 vaults=[keychain]
  inbox        agent-inbox/local@0.3.1   channels=[primary, dispatch]
  compute      builtin/local@0.4.0       host=darwin/arm64
  workspace    builtin/task-run@0.4.0    base_dir=~/runs
  repos        builtin/repo@0.4.0        attached=2 (foo/bar [main, clean], foo/baz [feat-x, dirty])
  tools        builtin/mcp@0.4.0         servers=[git-mcp, fs-mcp]
  permissions  example/loadout@1.2.0     ref=chat-agent
  sandbox      builtin/anthropic@0.4.0   mode=enforce, rules=12, limits set
```

`doctor`:

```
$ agent-env doctor

✓ identity     healthy
✓ secrets      healthy
✓ inbox        healthy   (last seen primary 12s ago)
✓ compute      healthy
✓ workspace    healthy   (~/runs accessible, 2.3GB free)
⚠ repos        2 attached
                ✓ foo/bar @ ~/code/bar (clean, main)
                ⚠ foo/baz @ ~/code/baz (dirty: 3 modified files)
✓ tools        2 servers OK
✓ permissions  loadout resolves
✓ sandbox      builtin/anthropic ready, 12 rules resolved

Overall: healthy with warnings
```

---

## Public API

```typescript
// agent-workspace/kinds/environment/index.ts

// Manifest types (camelCase, in-memory)
export type {
  AgentEnvironmentManifest,
  ResolvedEnvironmentManifest,
  ResolvedLayerEntry,
  EnvironmentLayer,
  ManifestValidationResult, ManifestValidationError,
} from './types.js';

// Provider interface
export type {
  Provider, ResolveContext, ResolvedLayers, HostInfo, LayerSummary,
  ProviderRegistry,
  UriHandler, UriHandlerContext, UriHandlers,
} from './provider.js';
export {
  createProviderRegistry,
  defaultProviderRegistry,
  defaultMergeConfig,
  defaultUriHandlers,
  defineProvider,                       // ergonomic provider authoring (E23)
} from './provider.js';

// Loader / resolver
export {
  parseApiVersion,                      // E26
  loadEnvironmentManifest,
  parseEnvironmentManifest,             // in-memory companion (E29)
  validateEnvironmentManifest,
  resolveEnvironment,
  createEnvironment,                    // high-level convenience
} from './resolver.js';
export type { ResolveEnvironmentOptions, ResolveWarning } from './resolver.js';

// Runtime
export type {
  Environment, DefaultLayers,
  EnvironmentSummary, EnvironmentHealth,
  DisposeResult, DisposeError,
} from './runtime.js';
export { reloadEnvironment } from './runtime.js';

// Activation
export {
  discoverActiveManifest,
  activateEnvironment,
  loadActiveEnvExports,
} from './activation.js';

// Lockfile
export {
  lockEnvironment,
  loadLockfile,
  isLockfileStale,
} from './lockfile.js';
export type { LockfileV1 } from './lockfile.js';

// Errors
export {
  EnvironmentError,
  UnknownLayerError, UnknownProviderError, MissingLayerError,
  CircularDependencyError, UnknownUriSchemeError,
  ProviderResolutionError, ManifestParseError,
  LockfileMismatchError, ProviderVersionMismatchError,
  CircularExtendsError, MissingResolvedLayerError,
  UriResolutionError, InvalidApiVersionError,
  InvalidProviderNameError, InvalidProviderVersionError,
} from './errors.js';

// Versioning
export const ENVIRONMENT_API_VERSION = 'agent-environment/v1' as const;
export const ENVIRONMENT_LOCK_VERSION = 'agent-environment-lock/v1' as const;
```

---

## Errors

```typescript
export abstract class EnvironmentError extends Error {
  abstract readonly code: string;
}

export class UnknownLayerError extends EnvironmentError {
  readonly code = 'unknown_layer';
  constructor(public layerName: string, public validLayers: readonly string[]);
}

export class UnknownProviderError extends EnvironmentError {
  readonly code = 'unknown_provider';
  constructor(public providerName: string, public layer: EnvironmentLayer);
}

export class MissingLayerError extends EnvironmentError {
  readonly code = 'missing_layer';
  constructor(public layer: EnvironmentLayer, public requiredBy: string);
}

export class CircularDependencyError extends EnvironmentError {
  readonly code = 'circular_dependency';
  constructor(public cycle: EnvironmentLayer[]);
}

export class UnknownUriSchemeError extends EnvironmentError {
  readonly code = 'unknown_uri_scheme';
  constructor(public scheme: string, public uri: string);
}

export class ProviderResolutionError extends EnvironmentError {
  readonly code = 'provider_resolution';
  constructor(
    public layer: EnvironmentLayer,
    public providerName: string,
    public cause: Error,
  );
}

export class ManifestParseError extends EnvironmentError {
  readonly code = 'manifest_parse';
  constructor(public path: string, public reason: string);
}

export class LockfileMismatchError extends EnvironmentError {
  readonly code = 'lockfile_mismatch';
  constructor(public expectedHash: string, public actualHash: string);
}

export class ProviderVersionMismatchError extends EnvironmentError {
  readonly code = 'provider_version_mismatch';
  constructor(
    public providerName: string,
    public requested: string,
    public installed: string,
    public severity: 'within_compat' | 'outside_compat',
  );
}

export class CircularExtendsError extends EnvironmentError {
  readonly code = 'circular_extends';
  constructor(public chain: string[]);
}

export class MissingResolvedLayerError extends EnvironmentError {
  readonly code = 'missing_resolved_layer';
  constructor(
    public layer: EnvironmentLayer,
    public requiredBy: string,
    public availableLayers: EnvironmentLayer[],
  );
}

export class UriResolutionError extends EnvironmentError {
  readonly code = 'uri_resolution';
  constructor(public scheme: string, public uri: string, public cause: Error);
}

export class InvalidApiVersionError extends EnvironmentError {
  readonly code = 'invalid_api_version';
  constructor(public input: string, public expected: string[]);
}

export class InvalidProviderNameError extends EnvironmentError {
  readonly code = 'invalid_provider_name';
  constructor(public name: string, public reason: string);
}

export class InvalidProviderVersionError extends EnvironmentError {
  readonly code = 'invalid_provider_version';
  constructor(public providerName: string, public version: string, public reason: string);
}
```

---

## Threat model

The environment kind is not itself a security boundary — that's the sandbox layer's job. But there are environment-level concerns worth being explicit about:

### Trust boundaries

- **Manifest is trusted.** Anyone with write access to the manifest file can change which providers run, with what config. Treat manifests as code: review them in PRs, sign them if your threat model demands it.
- **Custom providers are trusted code.** A custom provider running in your process has the same access as the agent. Strict environments should refuse non-`builtin/*` providers.
- **URI handlers are trusted code.** Same as providers.
- **Lockfile is data, not code.** Lockfile values can be tampered with, but the resolver re-validates them against the manifest hash; mismatches fail loudly.

### Strict mode

Resolver supports a `strict` mode that:
- Refuses non-`builtin/*` providers.
- Refuses non-builtin URI schemes.
- Errors instead of warning on backend-mode-mismatch (sandbox layer; cf. [sandbox.md](./sandbox.md)).
- Errors on missing optional fields rather than using defaults.

**Strict can be declared in two places:**

- **`metadata.strict: true`** in the manifest itself — committed to repos for hosted/multi-tenant use; survives lazy callers.
- **`options.strict: true`** at the resolver call site — opt-in per-call.

Effective strict = `manifest.strict || options.strict` (more restrictive wins). Consumers running hosted/multi-tenant environments default to one or the other; local dev defaults to neither.

**Strict is monotonic upward across `extends:` chains (E25).** Once any manifest in the chain declares `strict: true`, the resolved manifest is strict. Children attempting to set `strict: false` over a strict parent are *rejected*: the resolved value stays `true`, and a `'strict-downgrade-rejected'` warning fires through `onWarning`. Rationale: a parent committing to strict mode is asserting a security property the chain must preserve; a child should not silently weaken it.

### Default `builtin/identity-static` is dev-only

The default identity provider (`builtin/identity-static` with `ref: 'anonymous-local'`) is suitable only for **dev/test**. It allows any operation as an unauthenticated local actor.

Mitigations:

- `agent-env doctor` emits an `identity-anonymous-default` warning when the resolved identity is `builtin/identity-static`.
- The package emits the same warning at resolve time (via `onWarning`) so consumers can surface it.
- Production manifests should use a real identity provider (`agent-iam/oauth`, etc.) and declare `strict: true` so omitting identity fails loudly.
- Consumer environments running hosted/autonomous workloads should default to strict in their environment composer, eliminating the implicit-default path entirely.

### Lockfile snapshot contract — no secrets

`Provider.snapshotForLockfile?(handle)` is the provider's contribution to the lockfile. The contract is **the snapshot must not include secrets**. Lockfiles are gitignored by default but may be shared with teammates, copied via support channels, etc. — secrets must never enter the snapshot.

Provider authors are responsible for redacting before snapshotting. The package can't enforce this; the contract is documented and provider authors are trusted code (cf. above).

### What the environment layer does NOT protect

- **Manifest contents.** If the manifest itself contains a malicious layer, the environment will activate it. Mitigations are upstream (code review, signing).
- **Inter-environment isolation.** Two environments running in the same process share that process. Use compute backends with stronger boundaries (containers, microVMs) for isolation.
- **Time-based attacks via stale lockfiles.** If a referenced URI changed underneath the lockfile and you don't refresh, you might activate a stale state. `agent-env doctor` flags this.

---

## Open questions

1. **`extends:` URLs in v0.5+.** Convenient for shared team manifests but introduces remote-fetch attack surface. Ship with explicit allow-list (`extends_allow: [https://internal.acme/*]`) and HTTPS-only enforcement. Pin by content hash for reproducibility.
2. **Manifest signing.** Cryptographic signing for high-trust deployments. Probably out of scope for v0.4 — comes when first consumer needs it.
3. **Versioned manifest migrations.** When `api_version: agent-environment/v2` lands, do we ship migration tools? Probably yes — `agent-env migrate <name>` running automated rewrites.
4. **`describe` JSON output format.** Currently text-friendly with `--json` flag. Should we expose a stable JSON shape as the canonical form, with text as a renderer? Lean: yes for v0.5; keep text-first for v0.4.
5. **Per-session override matching beyond exact-match.** Today `when: { session_kind: dispatch }`. Glob? Regex? Pattern object with operators? Lean: keep exact-match in v0.4; revisit if real use case appears.
6. **Provider hot-reload.** Some providers might support reloading config without dispose+resolve. Lean: `provider.hotReload?(handle, newConfig)` optional method, future v0.5+.
7. **Multi-tenant provider registries.** A single host running many environments might want isolated registries (avoid cross-environment provider state). Currently `defaultProviderRegistry` is shared. Lean: encourage per-environment registries via `createProviderRegistry()`; default is for single-tenant convenience.
8. **`api_version` casing exception.** Some users may expect K8s-style `apiVersion`. We've gone consistent snake_case (`api_version`); if pushback emerges, accept both forms in the parser with a single canonical write.

---

## Cross-references

- [`architecture.md`](./architecture.md) — overall package architecture; environment kind is D4.
- [`repo-kind.md`](./repo-kind.md) — repo kind that the `repos` layer wraps.
- [`sandbox.md`](./sandbox.md) — sandbox v2 that the `sandbox` layer wraps.
- (TBD) `docs/design/cli.md` — detailed CLI design when `@agent-workspace/cli` lands.
- (TBD) `docs/design/provider-authoring.md` — guide for writing custom providers (`agent-iam/*`, `agent-inbox/*`, etc.).
