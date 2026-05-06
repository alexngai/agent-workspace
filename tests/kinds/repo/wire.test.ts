import { describe, it, expect } from 'vitest';
import {
  toWireDeclare,
  fromWireDeclare,
  toWireChanged,
  fromWireChanged,
} from '../../../src/kinds/repo/wire.js';
import type { RepoConfig } from '../../../src/kinds/repo/types.js';
import type {
  WorkspaceDeclareInput,
  RepoChangedParams,
} from '../../../src/protocol/repo.js';

describe('toWireDeclare', () => {
  it('converts camelCase RepoConfig to snake_case WorkspaceDeclareInput', () => {
    const config: RepoConfig = {
      remoteUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
      currentBranch: 'main',
      headSha: 'abc123',
      visibility: 'hub_local',
      instanceLabel: 'main worktree',
    };
    const [wire] = toWireDeclare([config]);
    expect(wire).toEqual({
      remote_url: 'https://github.com/foo/bar',
      local_path: '/tmp/bar',
      current_branch: 'main',
      head_sha: 'abc123',
      visibility: 'hub_local',
      instance_label: 'main worktree',
    });
  });

  it('omits undefined optional fields rather than emitting them as undefined', () => {
    const config: RepoConfig = {
      remoteUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
    };
    const [wire] = toWireDeclare([config]);
    expect(wire).toEqual({
      remote_url: 'https://github.com/foo/bar',
      local_path: '/tmp/bar',
    });
    expect(Object.keys(wire!)).toEqual(['remote_url', 'local_path']);
  });

  it('does NOT emit a `dirty` field (RepoConfig is declarative)', () => {
    const config: RepoConfig = {
      remoteUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
    };
    const [wire] = toWireDeclare([config]);
    expect(wire).not.toHaveProperty('dirty');
  });

  it('returns empty array for empty input', () => {
    expect(toWireDeclare([])).toEqual([]);
  });

  it('preserves array order', () => {
    const a: RepoConfig = { remoteUrl: 'https://github.com/a/a', localPath: '/a' };
    const b: RepoConfig = { remoteUrl: 'https://github.com/b/b', localPath: '/b' };
    const c: RepoConfig = { remoteUrl: 'https://github.com/c/c', localPath: '/c' };
    const result = toWireDeclare([a, b, c]);
    expect(result.map((w) => w.local_path)).toEqual(['/a', '/b', '/c']);
  });
});

describe('fromWireDeclare', () => {
  it('converts snake_case WorkspaceDeclareInput to camelCase RepoConfig', () => {
    const wire: WorkspaceDeclareInput = {
      remote_url: 'https://github.com/foo/bar',
      local_path: '/tmp/bar',
      current_branch: 'main',
      head_sha: 'abc123',
      visibility: 'federated',
      instance_label: 'main worktree',
    };
    const [config] = fromWireDeclare([wire]);
    expect(config).toEqual({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
      currentBranch: 'main',
      headSha: 'abc123',
      visibility: 'federated',
      instanceLabel: 'main worktree',
    });
  });

  it('drops the wire `dirty` field (not part of RepoConfig)', () => {
    const wire: WorkspaceDeclareInput = {
      remote_url: 'https://github.com/foo/bar',
      local_path: '/tmp/bar',
      dirty: true,
    };
    const [config] = fromWireDeclare([wire]);
    expect(config).not.toHaveProperty('dirty');
  });
});

describe('declare round-trip', () => {
  it('toWire ∘ fromWire = identity (without dirty)', () => {
    const config: RepoConfig = {
      remoteUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
      currentBranch: 'main',
      headSha: 'abc123',
      visibility: 'hub_local',
      instanceLabel: 'work',
    };
    expect(fromWireDeclare(toWireDeclare([config]))[0]).toEqual(config);
  });

  it('preserves field absence through round-trip', () => {
    const config: RepoConfig = {
      remoteUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
    };
    const round = fromWireDeclare(toWireDeclare([config]))[0];
    expect(round).toEqual(config);
    expect(round).not.toHaveProperty('currentBranch');
    expect(round).not.toHaveProperty('visibility');
  });
});

describe('toWireChanged', () => {
  it('converts added entries through toWireDeclare', () => {
    const params = toWireChanged({
      added: [{ remoteUrl: 'https://github.com/foo/bar', localPath: '/tmp/bar' }],
    });
    expect(params.added).toEqual([
      { remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' },
    ]);
  });

  it('converts removed entries with canonicalUrl → canonical_url, localPath → local_path', () => {
    const params = toWireChanged({
      removed: [{ canonicalUrl: 'https://github.com/foo/bar', localPath: '/tmp/bar' }],
    });
    expect(params.removed).toEqual([
      { canonical_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' },
    ]);
  });

  it('omits added/removed keys when arrays are empty or absent', () => {
    expect(toWireChanged({})).toEqual({});
    expect(toWireChanged({ added: [], removed: [] })).toEqual({});
  });

  it('supports a diff with only additions', () => {
    const params = toWireChanged({
      added: [{ remoteUrl: 'https://github.com/foo/bar', localPath: '/tmp/bar' }],
    });
    expect(params.added).toBeDefined();
    expect(params.removed).toBeUndefined();
  });
});

describe('fromWireChanged', () => {
  it('converts wire diff to in-memory diff with both arrays present', () => {
    const wire: RepoChangedParams = {
      added: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
      removed: [{ canonical_url: 'https://github.com/foo/baz', local_path: '/tmp/baz' }],
    };
    const result = fromWireChanged(wire);
    expect(result.added).toEqual([
      { remoteUrl: 'https://github.com/foo/bar', localPath: '/tmp/bar' },
    ]);
    expect(result.removed).toEqual([
      { canonicalUrl: 'https://github.com/foo/baz', localPath: '/tmp/baz' },
    ]);
  });

  it('returns empty arrays when wire diff has no added/removed', () => {
    expect(fromWireChanged({})).toEqual({ added: [], removed: [] });
  });
});

describe('changed round-trip', () => {
  it('toWireChanged ∘ fromWireChanged is identity for non-empty diff', () => {
    const original = {
      added: [{ remoteUrl: 'https://github.com/foo/bar', localPath: '/tmp/bar' }],
      removed: [{ canonicalUrl: 'https://github.com/foo/baz', localPath: '/tmp/baz' }],
    };
    const wire = toWireChanged(original);
    const round = fromWireChanged(wire);
    expect(round.added).toEqual(original.added);
    expect(round.removed).toEqual(original.removed);
  });
});
