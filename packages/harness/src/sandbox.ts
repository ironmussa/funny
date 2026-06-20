import { HarnessError } from './errors.js';

export type SandboxBackend = 'local' | 'process' | 'runner';

export type SandboxIntent = LocalSandboxIntent | ProcessSandboxIntent | RunnerSandboxIntent;

export interface LocalSandboxIntent {
  readonly kind: 'local';
}

export interface ProcessSandboxIntent {
  readonly kind: 'process';
  readonly isolation: 'podman' | (string & {});
  readonly requestId?: string;
  readonly worktreePath?: string;
  readonly env?: Record<string, string>;
  readonly metadata?: Record<string, unknown>;
}

export interface RunnerSandboxIntent {
  readonly kind: 'runner';
  readonly provider?: 'default' | (string & {});
  readonly threadId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SandboxExecutionRequest {
  intent: SandboxIntent;
  cwd: string;
  sessionId?: string;
  workflowName?: string;
  metadata?: Record<string, unknown>;
}

export interface SandboxExecutionHandle {
  id?: string;
  kind: SandboxBackend;
  cwd?: string;
  metadata?: Record<string, unknown>;
  spawnClaudeCodeProcess?: (options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) => unknown;
  cleanup?: () => Promise<void> | void;
}

export const sandbox = {
  local(): LocalSandboxIntent {
    return Object.freeze({ kind: 'local' as const });
  },

  process(
    options: Omit<ProcessSandboxIntent, 'kind'> = { isolation: 'podman' },
  ): ProcessSandboxIntent {
    const isolation = options.isolation ?? 'podman';
    if (!isolation.trim()) {
      throw new HarnessError(
        'unsupported_sandbox_backend',
        'Process sandbox isolation is required',
      );
    }
    return Object.freeze({
      kind: 'process' as const,
      isolation,
      requestId: options.requestId,
      worktreePath: options.worktreePath,
      env: options.env ? Object.freeze({ ...options.env }) : undefined,
      metadata: options.metadata ? Object.freeze({ ...options.metadata }) : undefined,
    });
  },

  runner(options: Omit<RunnerSandboxIntent, 'kind'> = {}): RunnerSandboxIntent {
    return Object.freeze({
      kind: 'runner' as const,
      provider: options.provider ?? 'default',
      threadId: options.threadId,
      metadata: options.metadata ? Object.freeze({ ...options.metadata }) : undefined,
    });
  },
};
