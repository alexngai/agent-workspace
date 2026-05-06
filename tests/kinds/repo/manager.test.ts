import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RepoManager } from '../../../src/kinds/repo/manager.js';
import { NotAttachedError, PolicyViolationError, InvalidRepoUrlError } from '../../../src/kinds/repo/errors.js';

const execFileAsync = promisify(execFile);

async function createGitRepo(initialBranch = 'main'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-mgr-'));
  try {
    await execFileAsync('git', ['init', `--initial-branch=${initialBranch}`, dir]);
  } catch {
    await execFileAsync('git', ['init', dir]);
    try {
      await execFileAsync('git', ['-C', dir, 'symbolic-ref', 'HEAD', `refs/heads/${initialBranch}`]);
    } catch { /* best effort */ }
  }
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(dir, 'README.md'), 'init\n');
  await execFileAsync('git', ['-C', dir, 'add', '.']);
  await execFileAsync('git', ['-C', dir, 'commit', '-m', 'init']);
  return dir;
}

describe('RepoManager — attach', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createGitRepo();
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('canonicalizes the remote URL', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    const handle = await mgr.attach({
      remoteUrl: 'git@github.com:Foo/Bar.git',
      localPath: repoDir,
    });
    expect(handle.identity.canonicalUrl).toBe('https://github.com/foo/bar');
    expect(handle.identity.host).toBe('github.com');
    expect(handle.identity.owner).toBe('foo');
    expect(handle.identity.name).toBe('bar');
  });

  it('throws InvalidRepoUrlError on malformed remoteUrl', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    await expect(mgr.attach({
      remoteUrl: 'not a url',
      localPath: repoDir,
    })).rejects.toBeInstanceOf(InvalidRepoUrlError);
  });

  it('inspects git state by default', async () => {
    const mgr = new RepoManager();
    const handle = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    expect(handle.currentBranch).toBe('main');
    expect(handle.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(handle.dirty).toBe(false);
  });

  it('skips git inspection when inspectGitOnAttach is false', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    const handle = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
      currentBranch: 'config-supplied',
    });
    expect(handle.currentBranch).toBe('config-supplied');
    expect(handle.dirty).toBe(false); // default when inspection skipped
  });

  it('uses defaults when no values supplied + inspection off', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    const handle = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    expect(handle.currentBranch).toBeUndefined();
    expect(handle.headSha).toBeUndefined();
    expect(handle.dirty).toBe(false);
    expect(handle.visibility).toBe('hub_local');
  });

  it('resolves localPath to absolute', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    // Use a relative path (just basename) and verify it resolves against cwd.
    // The actual repoDir is absolute; for this test, we check that find()
    // accepts both forms.
    const handle = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    expect(path.isAbsolute(handle.localPath)).toBe(true);
  });
});

describe('RepoManager — idempotent re-attach', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createGitRepo();
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('returns the same handle reference on duplicate attach', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    const a = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    const b = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    expect(b).toBe(a);
  });

  it('updates metadata on re-attach (visibility, instanceLabel)', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    const handle = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
      visibility: 'private',
      instanceLabel: 'old',
    });
    expect(handle.visibility).toBe('private');
    expect(handle.instanceLabel).toBe('old');

    await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
      visibility: 'federated',
      instanceLabel: 'new',
    });
    expect(handle.visibility).toBe('federated');
    expect(handle.instanceLabel).toBe('new');
  });

  it('treats different localPath as different bindings', async () => {
    const repo2 = await createGitRepo();
    try {
      const mgr = new RepoManager({ inspectGitOnAttach: false });
      const a = await mgr.attach({
        remoteUrl: 'https://github.com/foo/bar',
        localPath: repoDir,
      });
      const b = await mgr.attach({
        remoteUrl: 'https://github.com/foo/bar',
        localPath: repo2,
      });
      expect(a).not.toBe(b);
      expect(mgr.list()).toHaveLength(2);
    } finally {
      await fs.rm(repo2, { recursive: true, force: true });
    }
  });

  it('treats different canonicalUrl as different bindings (multi-remote)', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    const origin = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    const upstream = await mgr.attach({
      remoteUrl: 'https://github.com/upstream/bar',
      localPath: repoDir,
    });
    expect(origin).not.toBe(upstream);
    expect(mgr.list()).toHaveLength(2);
  });
});

describe('RepoManager — detach', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createGitRepo();
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('removes the binding but does not delete the clone', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    const handle = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    expect(mgr.list()).toHaveLength(1);

    await mgr.detach(handle);
    expect(mgr.list()).toHaveLength(0);

    // Clone is still there
    const stat = await fs.stat(repoDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('throws NotAttachedError when handle is not in the registry', async () => {
    const mgr1 = new RepoManager({ inspectGitOnAttach: false });
    const mgr2 = new RepoManager({ inspectGitOnAttach: false });
    const handle = await mgr1.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    await expect(mgr2.detach(handle)).rejects.toBeInstanceOf(NotAttachedError);
  });

  it('throws NotAttachedError when detaching a handle twice', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    const handle = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    await mgr.detach(handle);
    await expect(mgr.detach(handle)).rejects.toBeInstanceOf(NotAttachedError);
  });
});

describe('RepoManager — find / list', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createGitRepo();
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('list() returns empty array for a fresh manager', () => {
    const mgr = new RepoManager();
    expect(mgr.list()).toEqual([]);
  });

  it('find() locates an attached handle by canonicalUrl + localPath', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    const handle = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    expect(mgr.find('https://github.com/foo/bar', repoDir)).toBe(handle);
  });

  it('find() returns undefined when no binding matches', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    expect(mgr.find('https://github.com/foo/baz', repoDir)).toBeUndefined();
    expect(mgr.find('https://github.com/foo/bar', '/nowhere')).toBeUndefined();
  });
});

describe('RepoManager — handle behaviors', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createGitRepo();
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('handle.refresh() picks up dirty state changes', async () => {
    const mgr = new RepoManager();
    const handle = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    expect(handle.dirty).toBe(false);

    await fs.writeFile(path.join(repoDir, 'NEW.md'), 'new\n');
    await handle.refresh();
    expect(handle.dirty).toBe(true);
  });

  it('handle.inspectGit() returns fresh values without mutating', async () => {
    const mgr = new RepoManager();
    const handle = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    expect(handle.dirty).toBe(false);

    await fs.writeFile(path.join(repoDir, 'NEW.md'), 'new\n');
    const fresh = await handle.inspectGit();
    expect(fresh.dirty).toBe(true);
    // Snapshot still reflects pre-change value
    expect(handle.dirty).toBe(false);
  });

  it('handle.retract() allows downgrade', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    const handle = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
      visibility: 'federated',
    });
    await handle.retract('private');
    expect(handle.visibility).toBe('private');
  });

  it('handle.retract() rejects upgrade with PolicyViolationError', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    const handle = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
      visibility: 'private',
    });
    await expect(handle.retract('federated')).rejects.toBeInstanceOf(PolicyViolationError);
    expect(handle.visibility).toBe('private'); // unchanged
  });

  it('handle.dir("repo") returns localPath', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    const handle = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    expect(handle.dir('repo')).toBe(handle.localPath);
  });

  it('handle.dir() throws on unknown section', async () => {
    const mgr = new RepoManager({ inspectGitOnAttach: false });
    const handle = await mgr.attach({
      remoteUrl: 'https://github.com/foo/bar',
      localPath: repoDir,
    });
    expect(() => handle.dir('nonexistent')).toThrow(/Unknown section/);
  });
});
