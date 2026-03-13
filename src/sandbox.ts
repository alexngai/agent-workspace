import type { SandboxConfig } from './types.js';

/**
 * Minimal interface matching the subset of `@anthropic-ai/sandbox-runtime`
 * that we actually use. Keeps the dependency optional.
 */
interface SandboxManagerModule {
  SandboxManager: {
    initialize(config: unknown): Promise<void>;
    reset(): Promise<void>;
    wrapWithSandbox(command: string, binShell?: boolean, customConfig?: unknown, abortSignal?: AbortSignal): Promise<string>;
    isSandboxingEnabled(): boolean;
    isSupportedPlatform(): boolean;
    cleanupAfterCommand(): void;
    checkDependencies(): Promise<{ errors: string[]; warnings: string[] }>;
  };
}

let sandboxModule: SandboxManagerModule | undefined;

/**
 * Lazily load `@anthropic-ai/sandbox-runtime`.
 * Throws with a helpful message if the package isn't installed.
 */
async function loadSandboxRuntime(): Promise<SandboxManagerModule> {
  if (sandboxModule) return sandboxModule;
  try {
    sandboxModule = await import('@anthropic-ai/sandbox-runtime') as unknown as SandboxManagerModule;
    return sandboxModule;
  } catch {
    throw new Error(
      'Sandbox support requires the "@anthropic-ai/sandbox-runtime" package. ' +
      'Install it with: npm install @anthropic-ai/sandbox-runtime',
    );
  }
}

/**
 * Build the `SandboxRuntimeConfig` object that the sandbox-runtime package expects,
 * using our `SandboxConfig` plus workspace-scoped filesystem defaults.
 */
export function buildRuntimeConfig(
  sandboxConfig: SandboxConfig,
  workspacePath: string,
): Record<string, unknown> {
  const { network, filesystem, enableWeakerNestedSandbox } = sandboxConfig;

  const allowWrite = [workspacePath, ...(filesystem?.extraWritePaths ?? [])];
  const denyWrite = filesystem?.denyWrite ?? [];
  const denyRead = filesystem?.denyRead ?? [];
  const allowRead = filesystem?.allowRead ?? [];

  return {
    network: {
      allowedDomains: network?.allowedDomains ?? [],
      deniedDomains: network?.deniedDomains ?? [],
      allowLocalBinding: network?.allowLocalBinding ?? false,
    },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite,
    },
    enableWeakerNestedSandbox: enableWeakerNestedSandbox ?? false,
  };
}

/**
 * Initialize the sandbox runtime for a workspace.
 * Returns a `SandboxHandle` that allows wrapping commands and tearing down.
 */
export async function initializeSandbox(
  sandboxConfig: SandboxConfig,
  workspacePath: string,
): Promise<SandboxHandle> {
  const mod = await loadSandboxRuntime();

  if (!mod.SandboxManager.isSupportedPlatform()) {
    throw new Error(
      'Sandbox is not supported on this platform. ' +
      'Supported platforms: macOS and Linux (including WSL2).',
    );
  }

  const deps = await mod.SandboxManager.checkDependencies();
  if (deps.errors.length > 0) {
    throw new Error(
      `Sandbox dependency check failed:\n${deps.errors.join('\n')}`,
    );
  }

  const runtimeConfig = buildRuntimeConfig(sandboxConfig, workspacePath);
  await mod.SandboxManager.initialize(runtimeConfig);

  return new SandboxHandle(mod.SandboxManager);
}

/**
 * Handle for an active sandbox session.
 * Provides command wrapping and lifecycle management.
 */
export class SandboxHandle {
  private readonly manager: SandboxManagerModule['SandboxManager'];
  private _active = true;

  constructor(manager: SandboxManagerModule['SandboxManager']) {
    this.manager = manager;
  }

  /** Whether the sandbox session is still active. */
  get active(): boolean {
    return this._active;
  }

  /**
   * Wrap a shell command so it runs inside the sandbox.
   * @param command - The command string to sandbox.
   * @param abortSignal - Optional abort signal to cancel the wrap.
   * @returns The wrapped command string ready for execution via `child_process.spawn`.
   */
  async wrapCommand(command: string, abortSignal?: AbortSignal): Promise<string> {
    if (!this._active) {
      throw new Error('Sandbox session has been destroyed.');
    }
    return this.manager.wrapWithSandbox(command, undefined, undefined, abortSignal);
  }

  /** Clean up temporary mount points after a sandboxed command finishes. */
  cleanupAfterCommand(): void {
    if (!this._active) return;
    this.manager.cleanupAfterCommand();
  }

  /** Tear down the sandbox session entirely (stops proxies, cleans up). */
  async destroy(): Promise<void> {
    if (!this._active) return;
    this._active = false;
    await this.manager.reset();
  }
}
