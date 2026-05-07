/**
 * Async git inspection via `child_process.execFile`. No peer dependency.
 *
 * The three primitives the repo kind needs:
 * - current branch
 * - head SHA
 * - dirty status (`git status --porcelain`)
 *
 * All functions catch failure (missing path, not a git repo, git not installed)
 * and return `undefined` / `false` rather than throwing. Callers that need to
 * distinguish "no git" from "clean repo" should check both fields.
 *
 * Uses `execFile` (not `exec`) to avoid shell interpolation; arguments are
 * passed as an array.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Returns the current branch name, or `undefined` for detached HEAD or any
 * failure (missing path, not a git repo, git not installed).
 */
export async function getCurrentBranch(localPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', localPath, 'rev-parse', '--abbrev-ref', 'HEAD'],
    );
    const branch = stdout.trim();
    // `rev-parse --abbrev-ref HEAD` returns 'HEAD' for detached state.
    return branch === '' || branch === 'HEAD' ? undefined : branch;
  } catch {
    return undefined;
  }
}

/**
 * Returns the full HEAD SHA, or `undefined` on any failure.
 */
export async function getHeadSha(localPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', localPath, 'rev-parse', 'HEAD'],
    );
    const sha = stdout.trim();
    return sha === '' ? undefined : sha;
  } catch {
    return undefined;
  }
}

/**
 * Returns `true` iff the working tree has uncommitted changes.
 *
 * On any failure (missing path, not a git repo, git not installed), returns
 * `false`. The "treat unknown as clean" default is pragmatic — it lets
 * inspection-based callers treat the field as a boolean without `undefined`
 * handling. Callers that need to distinguish "clean" from "unknown" should
 * cross-check `getCurrentBranch` / `getHeadSha`.
 */
export async function isDirty(localPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', localPath, 'status', '--porcelain'],
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export interface GitInspectionResult {
  currentBranch: string | undefined;
  headSha: string | undefined;
  dirty: boolean;
}

/**
 * Runs all three inspections in parallel. Total time is dominated by the
 * slowest of the three rather than their sum.
 */
export async function inspectGitState(localPath: string): Promise<GitInspectionResult> {
  const [currentBranch, headSha, dirty] = await Promise.all([
    getCurrentBranch(localPath),
    getHeadSha(localPath),
    isDirty(localPath),
  ]);
  return { currentBranch, headSha, dirty };
}
