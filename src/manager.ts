import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { WorkspaceHandle } from './handle.js';
import type { CreateWorkspaceOptions, WorkspaceManagerConfig, WorkspaceMeta } from './types.js';

const DEFAULT_DIRS = ['input', 'output', 'resources', 'scratch'];
const META_FILE = '.workspace.json';

export class WorkspaceManager {
  private readonly baseDir: string;
  private readonly prefix: string;

  constructor(config: WorkspaceManagerConfig = {}) {
    this.baseDir = config.baseDir ?? os.tmpdir();
    this.prefix = config.prefix ?? 'agent-workspaces';
  }

  /** Root directory that contains all workspaces. */
  private get root(): string {
    return path.join(this.baseDir, this.prefix);
  }

  /** Create a new workspace with standard + optional additional directories. */
  async create(taskType: string, options: CreateWorkspaceOptions = {}): Promise<WorkspaceHandle> {
    const id = `${taskType}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const workspacePath = path.join(this.root, id);

    const allDirs = [...DEFAULT_DIRS, ...(options.additionalDirs ?? [])];

    // Create all directories in parallel
    await fs.mkdir(workspacePath, { recursive: true });
    await Promise.all(
      allDirs.map((dir) => fs.mkdir(path.join(workspacePath, dir), { recursive: true })),
    );

    const meta: WorkspaceMeta = {
      id,
      taskType,
      createdAt: new Date().toISOString(),
      dirs: allDirs,
    };

    await fs.writeFile(path.join(workspacePath, META_FILE), JSON.stringify(meta, null, 2));

    return new WorkspaceHandle(id, workspacePath, allDirs, new Date(meta.createdAt));
  }

  /** Remove a workspace from disk. */
  async cleanup(handle: WorkspaceHandle): Promise<void> {
    await fs.rm(handle.path, { recursive: true, force: true });
  }

  /** List all workspace handles under the managed root. */
  async list(): Promise<WorkspaceHandle[]> {
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      const handles: WorkspaceHandle[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const metaPath = path.join(this.root, entry.name, META_FILE);
        try {
          const raw = await fs.readFile(metaPath, 'utf-8');
          const meta: WorkspaceMeta = JSON.parse(raw);
          handles.push(
            new WorkspaceHandle(
              meta.id,
              path.join(this.root, entry.name),
              meta.dirs,
              new Date(meta.createdAt),
            ),
          );
        } catch {
          // Skip directories without valid metadata
        }
      }

      return handles;
    } catch {
      // Root doesn't exist yet — no workspaces
      return [];
    }
  }

  /** Remove workspaces older than `maxAgeMs` milliseconds. */
  async pruneStale(maxAgeMs: number): Promise<number> {
    const handles = await this.list();
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;

    for (const handle of handles) {
      if (handle.createdAt.getTime() < cutoff) {
        await this.cleanup(handle);
        pruned++;
      }
    }

    return pruned;
  }
}
