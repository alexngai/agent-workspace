import { describe, it, expect } from 'vitest';
import {
  RepoClient,
  type RepoClientTransport,
} from '../../../src/kinds/repo/client.js';
import { RepoManager } from '../../../src/kinds/repo/manager.js';
import { CapabilityError } from '../../../src/kinds/repo/errors.js';
import { REPO_METHODS } from '../../../src/protocol/repo.js';

interface RecordedNotify {
  method: string;
  params: unknown;
}

interface RecordedRequest {
  method: string;
  params: unknown;
}

/**
 * Minimal in-test transport that records `notify` calls and resolves `request`
 * responses from a configurable map. Optional `onRequest` capture lets us
 * verify auto-install behavior.
 */
class FakeTransport implements RepoClientTransport {
  notifies: RecordedNotify[] = [];
  requests: RecordedRequest[] = [];
  requestResponses: Map<string, unknown> = new Map();
  installedHandlers: Map<string, (params: unknown) => Promise<unknown>> = new Map();
  supportsOnRequest: boolean;

  constructor(opts: { supportsOnRequest?: boolean } = {}) {
    this.supportsOnRequest = opts.supportsOnRequest ?? true;
    if (!this.supportsOnRequest) {
      // Make `onRequest` undefined so the client cannot auto-install.
      (this as { onRequest?: unknown }).onRequest = undefined;
    }
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.notifies.push({ method, params });
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    return this.requestResponses.get(method) as T;
  }

  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
    if (!this.supportsOnRequest) return;
    this.installedHandlers.set(method, handler);
  }
}

describe('RepoClient.declare', () => {
  it('emits a notify with snake_case wire shape', async () => {
    const transport = new FakeTransport();
    const client = new RepoClient(transport);
    await client.declare([{
      remoteUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
      currentBranch: 'main',
      headSha: 'abc',
      visibility: 'hub_local',
      instanceLabel: 'work',
    }]);

    expect(transport.notifies).toHaveLength(1);
    expect(transport.notifies[0]!.method).toBe(REPO_METHODS.DECLARE);
    expect(transport.notifies[0]!.params).toEqual({
      workspaces: [{
        remote_url: 'https://github.com/foo/bar',
        local_path: '/tmp/bar',
        current_branch: 'main',
        head_sha: 'abc',
        visibility: 'hub_local',
        instance_label: 'work',
      }],
    });
  });

  it('emits empty workspaces array for empty input', async () => {
    const transport = new FakeTransport();
    const client = new RepoClient(transport);
    await client.declare([]);
    expect(transport.notifies[0]!.params).toEqual({ workspaces: [] });
  });
});

describe('RepoClient.changed', () => {
  it('emits a notify with diff in wire shape', async () => {
    const transport = new FakeTransport();
    const client = new RepoClient(transport);
    await client.changed({
      added: [{ remoteUrl: 'https://github.com/foo/bar', localPath: '/tmp/bar' }],
      removed: [{ canonicalUrl: 'https://github.com/foo/baz', localPath: '/tmp/baz' }],
    });

    expect(transport.notifies[0]!.method).toBe(REPO_METHODS.CHANGED);
    expect(transport.notifies[0]!.params).toEqual({
      added: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
      removed: [{ canonical_url: 'https://github.com/foo/baz', local_path: '/tmp/baz' }],
    });
  });

  it('omits empty added / removed arrays from the wire', async () => {
    const transport = new FakeTransport();
    const client = new RepoClient(transport);
    await client.changed({});
    expect(transport.notifies[0]!.params).toEqual({});
  });
});

describe('RepoClient.retract', () => {
  it('emits notify with canonical_url only when localPath omitted', async () => {
    const transport = new FakeTransport();
    const client = new RepoClient(transport);
    await client.retract('https://github.com/foo/bar');
    expect(transport.notifies[0]!.method).toBe(REPO_METHODS.RETRACT);
    expect(transport.notifies[0]!.params).toEqual({
      canonical_url: 'https://github.com/foo/bar',
    });
  });

  it('emits notify with both canonical_url and local_path when supplied', async () => {
    const transport = new FakeTransport();
    const client = new RepoClient(transport);
    await client.retract('https://github.com/foo/bar', '/tmp/bar');
    expect(transport.notifies[0]!.params).toEqual({
      canonical_url: 'https://github.com/foo/bar',
      local_path: '/tmp/bar',
    });
  });
});

describe('RepoClient.handleList', () => {
  it('dispatches to the configured onList handler', async () => {
    const transport = new FakeTransport();
    const client = new RepoClient(transport, {
      onList: async () => ({
        workspaces: [
          { remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' },
        ],
      }),
    });

    const result = await client.handleList({});
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]!.remote_url).toBe('https://github.com/foo/bar');
  });

  it('passes filter params through to the handler', async () => {
    const transport = new FakeTransport();
    let receivedFilter: unknown;
    const client = new RepoClient(transport, {
      onList: async (params) => {
        receivedFilter = params.filter;
        return { workspaces: [] };
      },
    });

    await client.handleList({ filter: { canonical_url: 'https://github.com/foo/bar' } });
    expect(receivedFilter).toEqual({ canonical_url: 'https://github.com/foo/bar' });
  });

  it('throws CapabilityError when no onList handler is configured', async () => {
    const transport = new FakeTransport();
    const client = new RepoClient(transport);
    await expect(client.handleList({})).rejects.toBeInstanceOf(CapabilityError);
  });
});

describe('RepoClient — auto-install onList via transport.onRequest', () => {
  it('installs handler when transport supports onRequest and onList is configured', () => {
    const transport = new FakeTransport({ supportsOnRequest: true });
    new RepoClient(transport, {
      onList: async () => ({ workspaces: [] }),
    });
    expect(transport.installedHandlers.has(REPO_METHODS.LIST)).toBe(true);
  });

  it('does NOT install when transport supports onRequest but onList is not configured', () => {
    const transport = new FakeTransport({ supportsOnRequest: true });
    new RepoClient(transport);
    expect(transport.installedHandlers.has(REPO_METHODS.LIST)).toBe(false);
  });

  it('does NOT install when transport does not support onRequest', () => {
    const transport = new FakeTransport({ supportsOnRequest: false });
    new RepoClient(transport, {
      onList: async () => ({ workspaces: [] }),
    });
    expect(transport.installedHandlers.has(REPO_METHODS.LIST)).toBe(false);
  });

  it('the auto-installed handler delegates to onList', async () => {
    const transport = new FakeTransport({ supportsOnRequest: true });
    new RepoClient(transport, {
      onList: async () => ({
        workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
      }),
    });

    const handler = transport.installedHandlers.get(REPO_METHODS.LIST)!;
    const result = await handler({});
    expect((result as { workspaces: unknown[] }).workspaces).toHaveLength(1);
  });
});

describe('RepoClient.snapshot', () => {
  it('snapshots an empty manager as empty array', () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    expect(RepoClient.snapshot(mgr)).toEqual([]);
  });

  it('snapshots attached handles into RepoConfig array', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
      currentBranch: 'main',
      visibility: 'hub_local',
    });
    await mgr.attach({
      remoteUrl: 'https://github.com/foo/baz',
      localPath: '/tmp/baz',
      visibility: 'federated',
      instanceLabel: 'feat',
    });

    const snapshot = RepoClient.snapshot(mgr);
    expect(snapshot).toHaveLength(2);
    // RepoConfig field shape (camelCase, no `dirty`)
    expect(snapshot[0]).toMatchObject({
      remoteUrl: 'https://github.com/foo/bar',
      currentBranch: 'main',
      visibility: 'hub_local',
    });
    expect(snapshot[0]).not.toHaveProperty('dirty');
    expect(snapshot[1]).toMatchObject({
      remoteUrl: 'https://github.com/foo/baz',
      visibility: 'federated',
      instanceLabel: 'feat',
    });
  });

  it('uses canonical URL (already canonicalized by manager) as remoteUrl', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    await mgr.attach({
      remoteUrl: 'git@github.com:Foo/Bar.git',
      localPath: '/tmp/bar',
    });

    const snapshot = RepoClient.snapshot(mgr);
    expect(snapshot[0]!.remoteUrl).toBe('https://github.com/foo/bar');
  });
});

describe('RepoClient — end-to-end: snapshot → declare', () => {
  it('snapshot of a manager is round-trippable through the wire', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
      currentBranch: 'main',
      visibility: 'federated',
    });

    const transport = new FakeTransport();
    const client = new RepoClient(transport);
    await client.declare(RepoClient.snapshot(mgr));

    const params = transport.notifies[0]!.params as { workspaces: Array<{ remote_url: string; current_branch?: string; visibility?: string }> };
    expect(params.workspaces).toHaveLength(1);
    expect(params.workspaces[0]).toMatchObject({
      remote_url: 'https://github.com/foo/bar',
      current_branch: 'main',
      visibility: 'federated',
    });
  });
});
