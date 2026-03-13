/**
 * Ambient type declaration for the optional `@anthropic-ai/sandbox-runtime` peer dependency.
 * This allows TypeScript to compile without the package installed.
 * The actual types are provided by the package when installed.
 */
declare module '@anthropic-ai/sandbox-runtime' {
  export const SandboxManager: {
    initialize(config: unknown): Promise<void>;
    reset(): Promise<void>;
    wrapWithSandbox(
      command: string,
      binShell?: boolean,
      customConfig?: unknown,
      abortSignal?: AbortSignal,
    ): Promise<string>;
    isSandboxingEnabled(): boolean;
    isSupportedPlatform(): boolean;
    cleanupAfterCommand(): void;
    checkDependencies(): Promise<{ errors: string[]; warnings: string[] }>;
  };
}
