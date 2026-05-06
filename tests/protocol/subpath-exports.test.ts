import { describe, it, expect } from 'vitest';

/**
 * Integration test for the package's subpath-export structure.
 *
 * Verifies that each subpath module exports its expected public symbols,
 * the umbrella module re-exports both submodules, the back-compat re-export
 * still works, and the package root re-exports the new resource-events
 * symbols. Catches re-export typos, missing symbols, and accidental drift
 * between the source layout and the package.json `exports` map.
 *
 * Note: this test imports from source paths (`../../src/...`) rather than
 * from `agent-workspace/...` package paths. The source-path imports verify
 * the module structure; the actual package.json `exports` field is verified
 * by the build (tsup emits the dist files referenced by `exports`).
 */

describe('agent-workspace/protocol/task', () => {
  it('exports WORKSPACE_METHODS with the canonical method names', async () => {
    const mod = await import('../../src/protocol/task.js');
    expect(mod.WORKSPACE_METHODS).toBeDefined();
    expect(mod.WORKSPACE_METHODS.EXECUTE).toBe('x-workspace/task.execute');
    expect(mod.WORKSPACE_METHODS.RESULT).toBe('x-workspace/task.result');
  });

  it('exports WORKSPACE_METHODS_LEGACY with the legacy method names', async () => {
    const mod = await import('../../src/protocol/task.js');
    expect(mod.WORKSPACE_METHODS_LEGACY).toBeDefined();
    expect(mod.WORKSPACE_METHODS_LEGACY.EXECUTE).toBe('x-openhive/learning.workspace.execute');
    expect(mod.WORKSPACE_METHODS_LEGACY.RESULT).toBe('x-openhive/learning.workspace.result');
  });
});

describe('agent-workspace/protocol/resource-events', () => {
  it('exports RESOURCE_MESH_EVENTS with the canonical event names', async () => {
    const mod = await import('../../src/protocol/resource-events.js');
    expect(mod.RESOURCE_MESH_EVENTS.REDACTED).toBe('resource.redacted');
    expect(mod.RESOURCE_MESH_EVENTS.ARCHIVED).toBe('resource.archived');
    expect(mod.RESOURCE_MESH_EVENTS.MERGED).toBe('resource.merged');
  });

  it('exports compareMergeEvents as a function', async () => {
    const mod = await import('../../src/protocol/resource-events.js');
    expect(mod.compareMergeEvents).toBeTypeOf('function');
  });
});

describe('agent-workspace/protocol (umbrella)', () => {
  it('re-exports task module symbols', async () => {
    const mod = await import('../../src/protocol/index.js');
    expect(mod.WORKSPACE_METHODS).toBeDefined();
    expect(mod.WORKSPACE_METHODS_LEGACY).toBeDefined();
  });

  it('re-exports resource-events module symbols', async () => {
    const mod = await import('../../src/protocol/index.js');
    expect(mod.RESOURCE_MESH_EVENTS).toBeDefined();
    expect(mod.compareMergeEvents).toBeTypeOf('function');
  });
});

describe('back-compat: src/task/protocol still re-exports protocol/task', () => {
  it('still exports WORKSPACE_METHODS via the legacy path', async () => {
    const mod = await import('../../src/task/protocol.js');
    expect(mod.WORKSPACE_METHODS).toBeDefined();
    expect(mod.WORKSPACE_METHODS_LEGACY).toBeDefined();
  });

  it('legacy path values are identical to the canonical path', async () => {
    const legacy = await import('../../src/task/protocol.js');
    const canonical = await import('../../src/protocol/task.js');
    expect(legacy.WORKSPACE_METHODS).toBe(canonical.WORKSPACE_METHODS);
    expect(legacy.WORKSPACE_METHODS_LEGACY).toBe(canonical.WORKSPACE_METHODS_LEGACY);
  });
});

describe('agent-workspace package root', () => {
  it('re-exports resource-events constants and comparator', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.RESOURCE_MESH_EVENTS).toBeDefined();
    expect(mod.compareMergeEvents).toBeTypeOf('function');
  });

  it('re-exports task protocol constants (existing path unchanged)', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.WORKSPACE_METHODS).toBeDefined();
    expect(mod.WORKSPACE_METHODS_LEGACY).toBeDefined();
  });

  it('re-exports canonical URL utility (added in kinds/repo slice 1)', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.canonicalizeRepoUrl).toBeTypeOf('function');
    expect(mod.tryCanonicalizeRepoUrl).toBeTypeOf('function');
    expect(mod.isSimilarRepoUrl).toBeTypeOf('function');
  });
});

describe('agent-workspace/protocol/repo', () => {
  it('exports REPO_METHODS with the four canonical method names', async () => {
    const mod = await import('../../src/protocol/repo.js');
    expect(mod.REPO_METHODS.DECLARE).toBe('x-workspace/repo.declare');
    expect(mod.REPO_METHODS.CHANGED).toBe('x-workspace/repo.changed');
    expect(mod.REPO_METHODS.LIST).toBe('x-workspace/repo.list');
    expect(mod.REPO_METHODS.RETRACT).toBe('x-workspace/repo.retract');
  });

  it('exports REPO_PROTOCOL_VERSION', async () => {
    const mod = await import('../../src/protocol/repo.js');
    expect(mod.REPO_PROTOCOL_VERSION).toBe('1');
  });

  it('re-exports resource-events constants for convenience', async () => {
    const mod = await import('../../src/protocol/repo.js');
    expect(mod.RESOURCE_MESH_EVENTS).toBeDefined();
    expect(mod.compareMergeEvents).toBeTypeOf('function');
  });
});

describe('agent-workspace/protocol (umbrella picks up repo)', () => {
  it('re-exports REPO_METHODS via the umbrella', async () => {
    const mod = await import('../../src/protocol/index.js');
    expect(mod.REPO_METHODS).toBeDefined();
    expect(mod.REPO_PROTOCOL_VERSION).toBe('1');
  });
});

describe('agent-workspace/kinds/repo', () => {
  it('exports the canonical URL utility', async () => {
    const mod = await import('../../src/kinds/repo/index.js');
    expect(mod.canonicalizeRepoUrl).toBeTypeOf('function');
    expect(mod.tryCanonicalizeRepoUrl).toBeTypeOf('function');
    expect(mod.isSimilarRepoUrl).toBeTypeOf('function');
    expect(mod.setRepoIdentityConfig).toBeTypeOf('function');
    expect(mod.getRepoIdentityConfig).toBeTypeOf('function');
  });

  it('exports the error hierarchy', async () => {
    const mod = await import('../../src/kinds/repo/index.js');
    expect(mod.RepoError).toBeDefined();
    expect(mod.InvalidRepoUrlError).toBeDefined();
    expect(mod.PolicyViolationError).toBeDefined();
    expect(mod.CapabilityError).toBeDefined();
    expect(mod.NotAttachedError).toBeDefined();
  });

  it('re-exports protocol shapes for convenience', async () => {
    const mod = await import('../../src/kinds/repo/index.js');
    expect(mod.REPO_METHODS).toBeDefined();
    expect(mod.REPO_PROTOCOL_VERSION).toBe('1');
    expect(mod.RESOURCE_MESH_EVENTS).toBeDefined();
    expect(mod.compareMergeEvents).toBeTypeOf('function');
  });

  it('exports wire translators (slice 2)', async () => {
    const mod = await import('../../src/kinds/repo/index.js');
    expect(mod.toWireDeclare).toBeTypeOf('function');
    expect(mod.fromWireDeclare).toBeTypeOf('function');
    expect(mod.toWireChanged).toBeTypeOf('function');
    expect(mod.fromWireChanged).toBeTypeOf('function');
  });

  it('exports policy hooks (slice 2)', async () => {
    const mod = await import('../../src/kinds/repo/index.js');
    expect(mod.effectiveVisibility).toBeTypeOf('function');
    expect(mod.isVisibilityDowngrade).toBeTypeOf('function');
    expect(mod.isVisibilityUpgrade).toBeTypeOf('function');
  });
});
