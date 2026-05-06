import { describe, it, expect } from 'vitest';
import {
  InMemoryRepoHandler,
  MockRepoTransport,
} from '../../../src/kinds/repo/testing.js';
import type { RepoHandlerContext } from '../../../src/kinds/repo/server.js';
import { REPO_METHODS } from '../../../src/protocol/repo.js';
import { RepoClient } from '../../../src/kinds/repo/client.js';

const a1: RepoHandlerContext = { agentId: 'a1', swarmId: 's1' };
const a2: RepoHandlerContext = { agentId: 'a2', swarmId: 's1' };

describe('InMemoryRepoHandler — declare', () => {
  it('creates a binding and a repo on first declare', async () => {
    const h = new InMemoryRepoHandler();
    await h.onDeclare({
      workspaces: [{
        remote_url: 'https://github.com/foo/bar',
        local_path: '/tmp/bar',
      }],
    }, a1);

    expect(h.listRepos()).toEqual([
      { canonicalUrl: 'https://github.com/foo/bar', visibility: 'hub_local' },
    ]);
    expect(h.listBindings()).toHaveLength(1);
    expect(h.listBindings()[0]).toMatchObject({
      agentId: 'a1',
      canonicalUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
      visibility: 'hub_local',
      dirty: false,
    });
  });

  it('canonicalizes the remote URL on the binding', async () => {
    const h = new InMemoryRepoHandler();
    await h.onDeclare({
      workspaces: [{
        remote_url: 'git@github.com:Foo/Bar.git',
        local_path: '/tmp/bar',
      }],
    }, a1);
    expect(h.listBindings()[0]!.canonicalUrl).toBe('https://github.com/foo/bar');
  });

  it('idempotent re-declare updates binding metadata in place', async () => {
    const h = new InMemoryRepoHandler();
    await h.onDeclare({
      workspaces: [{
        remote_url: 'https://github.com/foo/bar',
        local_path: '/tmp/bar',
        visibility: 'hub_local',
      }],
    }, a1);
    await h.onDeclare({
      workspaces: [{
        remote_url: 'https://github.com/foo/bar',
        local_path: '/tmp/bar',
        visibility: 'federated',
        instance_label: 'work',
      }],
    }, a1);
    expect(h.listBindings()).toHaveLength(1);
    expect(h.listBindings()[0]!.visibility).toBe('federated');
    expect(h.listBindings()[0]!.instanceLabel).toBe('work');
  });

  it('different agents declaring the same repo create separate bindings', async () => {
    const h = new InMemoryRepoHandler();
    await h.onDeclare({
      workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
    }, a1);
    await h.onDeclare({
      workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
    }, a2);
    expect(h.listBindings()).toHaveLength(2);
    expect(h.listRepos()).toHaveLength(1); // Single repo, two bindings.
  });
});

describe('InMemoryRepoHandler — changed', () => {
  it('added entries route through declare', async () => {
    const h = new InMemoryRepoHandler();
    await h.onChanged({
      added: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
    }, a1);
    expect(h.listBindings()).toHaveLength(1);
  });

  it('removed entries delete the matching binding', async () => {
    const h = new InMemoryRepoHandler();
    await h.onDeclare({
      workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
    }, a1);
    expect(h.listBindings()).toHaveLength(1);

    await h.onChanged({
      removed: [{ canonical_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
    }, a1);
    expect(h.listBindings()).toHaveLength(0);
  });

  it('removed only affects the calling agent\'s bindings', async () => {
    const h = new InMemoryRepoHandler();
    await h.onDeclare({
      workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
    }, a1);
    await h.onDeclare({
      workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
    }, a2);
    await h.onChanged({
      removed: [{ canonical_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
    }, a1);
    expect(h.listBindings()).toHaveLength(1);
    expect(h.listBindings()[0]!.agentId).toBe('a2');
  });

  it('added + removed in one diff applies both', async () => {
    const h = new InMemoryRepoHandler();
    await h.onDeclare({
      workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
    }, a1);
    await h.onChanged({
      added: [{ remote_url: 'https://github.com/foo/baz', local_path: '/tmp/baz' }],
      removed: [{ canonical_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
    }, a1);
    expect(h.listBindings()).toHaveLength(1);
    expect(h.listBindings()[0]!.canonicalUrl).toBe('https://github.com/foo/baz');
  });
});

describe('InMemoryRepoHandler — list visibility filter', () => {
  it('returns only bindings visible to the calling agent', async () => {
    const h = new InMemoryRepoHandler();
    // a1 declares a private binding
    await h.onDeclare({
      workspaces: [{
        remote_url: 'https://github.com/foo/bar',
        local_path: '/tmp/bar',
        visibility: 'private',
      }],
    }, a1);
    // a2 declares a hub_local binding for the same repo
    await h.onDeclare({
      workspaces: [{
        remote_url: 'https://github.com/foo/bar',
        local_path: '/tmp/bar2',
        visibility: 'hub_local',
      }],
    }, a2);

    // a1 sees both: own private + a2's hub_local
    const a1Result = await h.onList({}, a1);
    expect(a1Result.workspaces).toHaveLength(2);

    // a2 sees only its own hub_local (a1's private is filtered out)
    const a2Result = await h.onList({}, a2);
    expect(a2Result.workspaces).toHaveLength(1);
    expect(a2Result.workspaces[0]!.local_path).toBe('/tmp/bar2');
  });

  it('respects canonical_url filter', async () => {
    const h = new InMemoryRepoHandler();
    await h.onDeclare({
      workspaces: [
        { remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' },
        { remote_url: 'https://github.com/foo/baz', local_path: '/tmp/baz' },
      ],
    }, a1);

    const result = await h.onList({
      filter: { canonical_url: 'https://github.com/foo/bar' },
    }, a1);
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]!.remote_url).toBe('https://github.com/foo/bar');
  });

  it('emits wire-shape (snake_case) entries', async () => {
    const h = new InMemoryRepoHandler();
    await h.onDeclare({
      workspaces: [{
        remote_url: 'https://github.com/foo/bar',
        local_path: '/tmp/bar',
        current_branch: 'main',
        head_sha: 'abc',
        instance_label: 'work',
      }],
    }, a1);
    const result = await h.onList({}, a1);
    expect(result.workspaces[0]).toMatchObject({
      remote_url: 'https://github.com/foo/bar',
      local_path: '/tmp/bar',
      current_branch: 'main',
      head_sha: 'abc',
      instance_label: 'work',
      dirty: false,
      visibility: 'hub_local',
    });
  });
});

describe('InMemoryRepoHandler — retract', () => {
  it('narrows a single binding to private', async () => {
    const h = new InMemoryRepoHandler();
    await h.onDeclare({
      workspaces: [{
        remote_url: 'https://github.com/foo/bar',
        local_path: '/tmp/bar',
        visibility: 'federated',
      }],
    }, a1);
    await h.onRetract({
      canonical_url: 'https://github.com/foo/bar',
      local_path: '/tmp/bar',
    }, a1);
    expect(h.listBindings()[0]!.visibility).toBe('private');
  });

  it('narrows all bindings for a repo when local_path omitted', async () => {
    const h = new InMemoryRepoHandler();
    await h.onDeclare({
      workspaces: [
        { remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar1', visibility: 'federated' },
        { remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar2', visibility: 'hub_local' },
      ],
    }, a1);
    await h.onRetract({ canonical_url: 'https://github.com/foo/bar' }, a1);

    const bindings = h.listBindings();
    expect(bindings).toHaveLength(2);
    expect(bindings.every((b) => b.visibility === 'private')).toBe(true);
  });

  it('only retracts the calling agent\'s bindings', async () => {
    const h = new InMemoryRepoHandler();
    await h.onDeclare({
      workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar', visibility: 'federated' }],
    }, a1);
    await h.onDeclare({
      workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar', visibility: 'federated' }],
    }, a2);
    await h.onRetract({ canonical_url: 'https://github.com/foo/bar' }, a1);

    const a1Binding = h.listBindings().find((b) => b.agentId === 'a1');
    const a2Binding = h.listBindings().find((b) => b.agentId === 'a2');
    expect(a1Binding!.visibility).toBe('private');
    expect(a2Binding!.visibility).toBe('federated');
  });

  it('is a no-op for already-private bindings', async () => {
    const h = new InMemoryRepoHandler();
    await h.onDeclare({
      workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar', visibility: 'private' }],
    }, a1);
    await h.onRetract({ canonical_url: 'https://github.com/foo/bar' }, a1);
    expect(h.listBindings()[0]!.visibility).toBe('private');
  });
});

describe('InMemoryRepoHandler — reset', () => {
  it('clears all repos and bindings', async () => {
    const h = new InMemoryRepoHandler();
    await h.onDeclare({
      workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
    }, a1);
    expect(h.listBindings()).toHaveLength(1);

    h.reset();
    expect(h.listBindings()).toEqual([]);
    expect(h.listRepos()).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// MockRepoTransport
// ──────────────────────────────────────────────────────────────────────────────

describe('MockRepoTransport — recording', () => {
  it('records notify() calls in order', async () => {
    const t = new MockRepoTransport();
    await t.notify('a', { v: 1 });
    await t.notify('b', { v: 2 });
    expect(t.notifies).toEqual([
      { method: 'a', params: { v: 1 } },
      { method: 'b', params: { v: 2 } },
    ]);
  });

  it('records request() calls and returns canned responses', async () => {
    const t = new MockRepoTransport();
    t.requestResponses.set('foo', { ok: true });
    const result = await t.request<{ ok: boolean }>('foo', {});
    expect(result).toEqual({ ok: true });
    expect(t.requests).toHaveLength(1);
  });

  it('returns undefined for un-canned request methods', async () => {
    const t = new MockRepoTransport();
    const result = await t.request('uncanned', {});
    expect(result).toBeUndefined();
  });
});

describe('MockRepoTransport — onRequest + simulateInbound', () => {
  it('captures handlers installed via onRequest', () => {
    const t = new MockRepoTransport();
    t.onRequest('m', async () => 'response');
    expect(t.installedHandlers.has('m')).toBe(true);
  });

  it('simulateInbound dispatches to the installed handler', async () => {
    const t = new MockRepoTransport();
    t.onRequest('m', async (params) => ({ echoed: params }));
    const result = await t.simulateInbound('m', { foo: 1 });
    expect(result).toEqual({ echoed: { foo: 1 } });
  });

  it('simulateInbound throws when no handler is installed', async () => {
    const t = new MockRepoTransport();
    await expect(t.simulateInbound('not-installed', {})).rejects.toThrow(
      /no handler installed/,
    );
  });

  it('integrates end-to-end with RepoClient.handleList via simulateInbound', async () => {
    const t = new MockRepoTransport();
    new RepoClient(t, {
      onList: async () => ({
        workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }],
      }),
    });
    // Client auto-installed via onRequest. Hub simulates calling list.
    const result = (await t.simulateInbound(REPO_METHODS.LIST, {})) as { workspaces: unknown[] };
    expect(result.workspaces).toHaveLength(1);
  });
});

describe('MockRepoTransport — reset', () => {
  it('clears notifies, requests, responses, and handlers', async () => {
    const t = new MockRepoTransport();
    await t.notify('a', {});
    await t.request('b', {});
    t.requestResponses.set('c', 1);
    t.onRequest('d', async () => null);

    t.reset();
    expect(t.notifies).toEqual([]);
    expect(t.requests).toEqual([]);
    expect(t.requestResponses.size).toBe(0);
    expect(t.installedHandlers.size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// End-to-end: client + InMemoryRepoHandler via mock transport
// ──────────────────────────────────────────────────────────────────────────────

describe('end-to-end: RepoClient → MockRepoTransport → InMemoryRepoHandler', () => {
  it('declare on the client lands as a binding on the handler', async () => {
    const handler = new InMemoryRepoHandler();
    const transport = new MockRepoTransport();
    const client = new RepoClient(transport);

    await client.declare([{
      remoteUrl: 'https://github.com/foo/bar',
      localPath: '/tmp/bar',
    }]);

    // Manually feed the recorded notify into the handler (simulating the hub
    // side of a real transport).
    const recorded = transport.notifies[0]!;
    expect(recorded.method).toBe(REPO_METHODS.DECLARE);
    await handler.onDeclare(
      recorded.params as Parameters<InMemoryRepoHandler['onDeclare']>[0],
      a1,
    );

    expect(handler.listBindings()).toHaveLength(1);
    expect(handler.listBindings()[0]!.canonicalUrl).toBe('https://github.com/foo/bar');
  });
});
