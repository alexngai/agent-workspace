import { describe, it, expect } from 'vitest';
import {
  registerRepoHandlers,
  type RepoProtocolHandler,
  type RepoHandlerContext,
  type RepoMethodServer,
} from '../../../src/kinds/repo/server.js';
import { REPO_METHODS } from '../../../src/protocol/repo.js';

/**
 * In-test JSON-RPC server with optional `removeHandler`. Used to verify both
 * register-only and register-then-unregister flows.
 */
class FakeServer implements RepoMethodServer {
  handlers: Map<string, (params: unknown, ctx: unknown) => Promise<unknown>> = new Map();
  supportsRemove: boolean;

  constructor(opts: { supportsRemove?: boolean } = {}) {
    this.supportsRemove = opts.supportsRemove ?? true;
    if (!this.supportsRemove) {
      // Make removeHandler undefined so unregister becomes a no-op.
      (this as { removeHandler?: unknown }).removeHandler = undefined;
    }
  }

  addHandler(method: string, fn: (params: unknown, ctx: unknown) => Promise<unknown>): void {
    this.handlers.set(method, fn);
  }

  removeHandler(method: string): void {
    if (!this.supportsRemove) return;
    this.handlers.delete(method);
  }
}

/** Tracks calls to each handler method for assertions. */
class CountingHandler implements RepoProtocolHandler {
  calls = {
    onDeclare: [] as Array<{ params: unknown; ctx: unknown }>,
    onChanged: [] as Array<{ params: unknown; ctx: unknown }>,
    onList: [] as Array<{ params: unknown; ctx: unknown }>,
    onRetract: [] as Array<{ params: unknown; ctx: unknown }>,
  };

  async onDeclare(params: unknown, ctx: unknown): Promise<void> {
    this.calls.onDeclare.push({ params, ctx });
  }
  async onChanged(params: unknown, ctx: unknown): Promise<void> {
    this.calls.onChanged.push({ params, ctx });
  }
  async onList(params: unknown, ctx: unknown): Promise<{ workspaces: never[] }> {
    this.calls.onList.push({ params, ctx });
    return { workspaces: [] };
  }
  async onRetract(params: unknown, ctx: unknown): Promise<void> {
    this.calls.onRetract.push({ params, ctx });
  }
}

const baseCtx: RepoHandlerContext = { agentId: 'a1', swarmId: 's1' };

describe('registerRepoHandlers — wires all four methods', () => {
  it('registers handlers for all four x-workspace/repo.* methods', () => {
    const server = new FakeServer();
    const handler = new CountingHandler();
    registerRepoHandlers(server, handler);

    expect(server.handlers.has(REPO_METHODS.DECLARE)).toBe(true);
    expect(server.handlers.has(REPO_METHODS.CHANGED)).toBe(true);
    expect(server.handlers.has(REPO_METHODS.LIST)).toBe(true);
    expect(server.handlers.has(REPO_METHODS.RETRACT)).toBe(true);
    expect(server.handlers.size).toBe(4);
  });
});

describe('registerRepoHandlers — dispatches to handler methods', () => {
  it('declare dispatches to onDeclare with params and ctx', async () => {
    const server = new FakeServer();
    const handler = new CountingHandler();
    registerRepoHandlers(server, handler);

    const params = { workspaces: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }] };
    await server.handlers.get(REPO_METHODS.DECLARE)!(params, baseCtx);
    expect(handler.calls.onDeclare).toHaveLength(1);
    expect(handler.calls.onDeclare[0]!.params).toEqual(params);
    expect(handler.calls.onDeclare[0]!.ctx).toEqual(baseCtx);
  });

  it('changed dispatches to onChanged', async () => {
    const server = new FakeServer();
    const handler = new CountingHandler();
    registerRepoHandlers(server, handler);

    const params = { added: [{ remote_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' }] };
    await server.handlers.get(REPO_METHODS.CHANGED)!(params, baseCtx);
    expect(handler.calls.onChanged).toHaveLength(1);
    expect(handler.calls.onChanged[0]!.params).toEqual(params);
  });

  it('list dispatches to onList and returns the result', async () => {
    const server = new FakeServer();
    const handler = new CountingHandler();
    registerRepoHandlers(server, handler);

    const result = await server.handlers.get(REPO_METHODS.LIST)!({}, baseCtx);
    expect(handler.calls.onList).toHaveLength(1);
    expect(result).toEqual({ workspaces: [] });
  });

  it('retract dispatches to onRetract', async () => {
    const server = new FakeServer();
    const handler = new CountingHandler();
    registerRepoHandlers(server, handler);

    const params = { canonical_url: 'https://github.com/foo/bar', local_path: '/tmp/bar' };
    await server.handlers.get(REPO_METHODS.RETRACT)!(params, baseCtx);
    expect(handler.calls.onRetract).toHaveLength(1);
    expect(handler.calls.onRetract[0]!.params).toEqual(params);
  });
});

describe('registerRepoHandlers — context propagation', () => {
  it('forwards full context including capabilities', async () => {
    const server = new FakeServer();
    const handler = new CountingHandler();
    registerRepoHandlers(server, handler);

    const ctx: RepoHandlerContext = {
      agentId: 'a1',
      swarmId: 's1',
      capabilities: {
        protocolVersion: '1',
        declare: { enabled: true, defaultVisibility: 'hub_local' },
        list: { enabled: true },
      },
    };
    await server.handlers.get(REPO_METHODS.DECLARE)!({ workspaces: [] }, ctx);
    expect(handler.calls.onDeclare[0]!.ctx).toEqual(ctx);
  });
});

describe('registerRepoHandlers — unregister behavior', () => {
  it('unregister tears down all four handlers when removeHandler is supplied', () => {
    const server = new FakeServer({ supportsRemove: true });
    const handler = new CountingHandler();
    const { unregister } = registerRepoHandlers(server, handler);
    expect(server.handlers.size).toBe(4);

    unregister();
    expect(server.handlers.size).toBe(0);
  });

  it('unregister is a no-op when removeHandler is not supplied', () => {
    const server = new FakeServer({ supportsRemove: false });
    const handler = new CountingHandler();
    const { unregister } = registerRepoHandlers(server, handler);
    expect(server.handlers.size).toBe(4);

    expect(() => unregister()).not.toThrow();
    expect(server.handlers.size).toBe(4); // unchanged
  });

  it('multiple unregisters are safe', () => {
    const server = new FakeServer();
    const handler = new CountingHandler();
    const { unregister } = registerRepoHandlers(server, handler);

    expect(() => {
      unregister();
      unregister();
    }).not.toThrow();
  });
});

describe('registerRepoHandlers — error propagation from handler', () => {
  it('rejection from handler propagates to the dispatched call', async () => {
    const server = new FakeServer();
    const handler: RepoProtocolHandler = {
      onDeclare: async () => { throw new Error('hub policy denied'); },
      onChanged: async () => {},
      onList: async () => ({ workspaces: [] }),
      onRetract: async () => {},
    };
    registerRepoHandlers(server, handler);

    await expect(
      server.handlers.get(REPO_METHODS.DECLARE)!({ workspaces: [] }, baseCtx),
    ).rejects.toThrow('hub policy denied');
  });
});
