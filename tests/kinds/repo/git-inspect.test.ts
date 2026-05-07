import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getCurrentBranch,
  getHeadSha,
  isDirty,
  inspectGitState,
} from '../../../src/kinds/repo/git-inspect.js';

const execFileAsync = promisify(execFile);

/**
 * Create a temp dir, run `git init`, and return the path.
 * Uses `--initial-branch=main` for predictable branch naming across platforms.
 * Falls back to renaming `master` → `main` if the flag isn't supported.
 */
async function createGitRepo(initialBranch = 'main'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-git-inspect-'));
  try {
    await execFileAsync('git', ['init', `--initial-branch=${initialBranch}`, dir]);
  } catch {
    // Older git: --initial-branch unsupported; fall back to init + branch rename.
    await execFileAsync('git', ['init', dir]);
    try {
      await execFileAsync('git', ['-C', dir, 'symbolic-ref', 'HEAD', `refs/heads/${initialBranch}`]);
    } catch {
      // Best effort
    }
  }
  // Set local user so commits don't fail with "please tell me who you are."
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test User']);
  return dir;
}

async function commitSomething(dir: string, content = 'hello\n'): Promise<void> {
  await fs.writeFile(path.join(dir, 'README.md'), content);
  await execFileAsync('git', ['-C', dir, 'add', '.']);
  await execFileAsync('git', ['-C', dir, 'commit', '-m', 'init']);
}

describe('getCurrentBranch', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createGitRepo('main');
    await commitSomething(repoDir);
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('returns the branch name in a normal repo', async () => {
    expect(await getCurrentBranch(repoDir)).toBe('main');
  });

  it('returns undefined for detached HEAD', async () => {
    const { stdout } = await execFileAsync('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
    const sha = stdout.trim();
    await execFileAsync('git', ['-C', repoDir, 'checkout', '--detach', sha]);
    expect(await getCurrentBranch(repoDir)).toBeUndefined();
  });

  it('returns undefined for a non-git directory', async () => {
    const nonGit = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-non-git-'));
    try {
      expect(await getCurrentBranch(nonGit)).toBeUndefined();
    } finally {
      await fs.rm(nonGit, { recursive: true, force: true });
    }
  });

  it('returns undefined for a missing path', async () => {
    expect(await getCurrentBranch('/nonexistent/path/xyz')).toBeUndefined();
  });
});

describe('getHeadSha', () => {
  it('returns the SHA in a committed repo', async () => {
    const dir = await createGitRepo();
    try {
      await commitSomething(dir);
      const sha = await getHeadSha(dir);
      expect(sha).toBeDefined();
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for an empty repo (no commits)', async () => {
    const dir = await createGitRepo();
    try {
      expect(await getHeadSha(dir)).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for a non-git directory', async () => {
    const nonGit = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-non-git-'));
    try {
      expect(await getHeadSha(nonGit)).toBeUndefined();
    } finally {
      await fs.rm(nonGit, { recursive: true, force: true });
    }
  });
});

describe('isDirty', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createGitRepo();
    await commitSomething(repoDir);
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('returns false for a clean working tree', async () => {
    expect(await isDirty(repoDir)).toBe(false);
  });

  it('returns true when there are uncommitted changes', async () => {
    await fs.writeFile(path.join(repoDir, 'NEW.md'), 'new content\n');
    expect(await isDirty(repoDir)).toBe(true);
  });

  it('returns true when an existing tracked file is modified', async () => {
    await fs.writeFile(path.join(repoDir, 'README.md'), 'changed\n');
    expect(await isDirty(repoDir)).toBe(true);
  });

  it('returns false for a non-git directory (best-effort default)', async () => {
    const nonGit = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-non-git-'));
    try {
      expect(await isDirty(nonGit)).toBe(false);
    } finally {
      await fs.rm(nonGit, { recursive: true, force: true });
    }
  });
});

describe('inspectGitState', () => {
  it('returns combined fields for a populated repo', async () => {
    const dir = await createGitRepo('main');
    try {
      await commitSomething(dir);
      const state = await inspectGitState(dir);
      expect(state.currentBranch).toBe('main');
      expect(state.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(state.dirty).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reflects dirty state', async () => {
    const dir = await createGitRepo('main');
    try {
      await commitSomething(dir);
      await fs.writeFile(path.join(dir, 'extra.txt'), 'unstaged\n');
      const state = await inspectGitState(dir);
      expect(state.dirty).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns all-undefined / false for a non-git directory', async () => {
    const nonGit = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-non-git-'));
    try {
      const state = await inspectGitState(nonGit);
      expect(state.currentBranch).toBeUndefined();
      expect(state.headSha).toBeUndefined();
      expect(state.dirty).toBe(false);
    } finally {
      await fs.rm(nonGit, { recursive: true, force: true });
    }
  });
});
