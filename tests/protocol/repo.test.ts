import { describe, it, expect } from 'vitest';
import {
  REPO_METHODS,
  REPO_PROTOCOL_VERSION,
  type RepoVisibility,
  type WorkspaceDeclareInput,
  type RepoDeclareParams,
  type RepoChangedParams,
  type RepoListParams,
  type RepoListResult,
  type RepoRetractParams,
  type WorkspaceCapability,
  type RepoMethodName,
  // re-exports from resource-events
  RESOURCE_MESH_EVENTS,
  compareMergeEvents,
} from '../../src/protocol/repo.js';

describe('REPO_METHODS', () => {
  it('exports the four canonical method names', () => {
    expect(REPO_METHODS.DECLARE).toBe('x-workspace/repo.declare');
    expect(REPO_METHODS.CHANGED).toBe('x-workspace/repo.changed');
    expect(REPO_METHODS.LIST).toBe('x-workspace/repo.list');
    expect(REPO_METHODS.RETRACT).toBe('x-workspace/repo.retract');
  });

  it('RepoMethodName type covers all method values', () => {
    // Compile-time check: any RepoMethodName must be one of the four.
    const names: RepoMethodName[] = [
      REPO_METHODS.DECLARE,
      REPO_METHODS.CHANGED,
      REPO_METHODS.LIST,
      REPO_METHODS.RETRACT,
    ];
    expect(names).toHaveLength(4);
  });
});

describe('REPO_PROTOCOL_VERSION', () => {
  it('is the v1 string literal', () => {
    expect(REPO_PROTOCOL_VERSION).toBe('1');
  });
});

describe('Wire type shapes (snake_case sanity checks)', () => {
  it('WorkspaceDeclareInput accepts the documented snake_case fields', () => {
    const input: WorkspaceDeclareInput = {
      remote_url: 'https://github.com/foo/bar',
      local_path: '/tmp/bar',
      current_branch: 'main',
      head_sha: 'abc123',
      dirty: false,
      visibility: 'hub_local',
      instance_label: 'main worktree',
    };
    expect(input.remote_url).toBe('https://github.com/foo/bar');
  });

  it('RepoDeclareParams wraps a workspaces array', () => {
    const params: RepoDeclareParams = {
      workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
    };
    expect(params.workspaces).toHaveLength(1);
  });

  it('RepoChangedParams supports added + removed diffs', () => {
    const params: RepoChangedParams = {
      added: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
      removed: [{ canonical_url: 'https://github.com/foo/baz', local_path: '/tmp/baz' }],
    };
    expect(params.added).toHaveLength(1);
    expect(params.removed).toHaveLength(1);
  });

  it('RepoListParams.filter is optional and supports canonical_url', () => {
    const a: RepoListParams = {};
    const b: RepoListParams = { filter: { canonical_url: 'https://github.com/foo/bar' } };
    expect(a.filter).toBeUndefined();
    expect(b.filter?.canonical_url).toBe('https://github.com/foo/bar');
  });

  it('RepoListResult holds workspaces array', () => {
    const result: RepoListResult = { workspaces: [] };
    expect(result.workspaces).toEqual([]);
  });

  it('RepoRetractParams local_path is optional (omit to retract all bindings for repo)', () => {
    const all: RepoRetractParams = { canonical_url: 'https://github.com/foo/bar' };
    const one: RepoRetractParams = {
      canonical_url: 'https://github.com/foo/bar',
      local_path: '/tmp/bar',
    };
    expect(all.local_path).toBeUndefined();
    expect(one.local_path).toBe('/tmp/bar');
  });
});

describe('RepoVisibility', () => {
  it('has three tiers: private | hub_local | federated', () => {
    const tiers: RepoVisibility[] = ['private', 'hub_local', 'federated'];
    expect(tiers).toHaveLength(3);
  });
});

describe('WorkspaceCapability (camelCase per MAP convention)', () => {
  it('uses camelCase fields and supports per-method declarations', () => {
    const cap: WorkspaceCapability = {
      protocolVersion: REPO_PROTOCOL_VERSION,
      declare: {
        enabled: true,
        defaultVisibility: 'hub_local',
        maxVisibility: 'federated',
      },
      list: { enabled: true },
    };
    expect(cap.protocolVersion).toBe('1');
    expect(cap.declare.enabled).toBe(true);
    expect(cap.list.enabled).toBe(true);
  });

  it('maxVisibility is optional', () => {
    const cap: WorkspaceCapability = {
      protocolVersion: REPO_PROTOCOL_VERSION,
      declare: { enabled: true, defaultVisibility: 'private' },
      list: { enabled: false },
    };
    expect(cap.declare.maxVisibility).toBeUndefined();
  });
});

describe('protocol/repo re-exports resource-events for convenience', () => {
  it('RESOURCE_MESH_EVENTS available via protocol/repo', () => {
    expect(RESOURCE_MESH_EVENTS.REDACTED).toBe('resource.redacted');
  });

  it('compareMergeEvents available via protocol/repo', () => {
    expect(compareMergeEvents).toBeTypeOf('function');
  });
});
