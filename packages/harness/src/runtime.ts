import type { HarnessAgentDefinition } from './agent.js';
import type { HarnessError } from './errors.js';
import type { HarnessEvent, HarnessEventSink } from './events.js';
import type { SandboxExecutionHandle, SandboxExecutionRequest, SandboxIntent } from './sandbox.js';
import type { HarnessTool } from './tools.js';

export interface HarnessRuntimeCapabilities {
  commands?: boolean;
  approvals?: boolean;
  notifications?: boolean;
  toolExposure?: boolean;
  processSandbox?: boolean;
  runnerSandbox?: boolean;
  cancellation?: boolean;
}

export interface HarnessRuntime {
  readonly name?: string;
  readonly capabilities?: HarnessRuntimeCapabilities;
  spawnAgent(request: HarnessAgentRequest): Promise<HarnessAgentResult>;
  runCommand?(request: HarnessCommandRequest): Promise<HarnessCommandResult>;
  requestApproval?(request: HarnessApprovalRequest): Promise<HarnessApprovalDecision>;
  notify?(event: HarnessEvent): void | Promise<void>;
  resolveSandbox?(request: SandboxExecutionRequest): Promise<SandboxExecutionHandle>;
  exposeTools?(tools: readonly HarnessTool[]): Promise<HarnessToolExposure> | HarnessToolExposure;
}

export interface HarnessToolExposure {
  mcpServers?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface HarnessAgentRequest {
  agent: HarnessAgentDefinition;
  prompt: string;
  cwd: string;
  sessionId?: string;
  images?: unknown[];
  signal?: AbortSignal;
  sandbox: SandboxIntent;
  resolvedSandbox?: SandboxExecutionHandle;
  tools: readonly HarnessTool[];
  onEvent?: HarnessEventSink;
  metadata?: Record<string, unknown>;
}

export interface HarnessAgentResult {
  ok: boolean;
  output?: string;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  raw?: unknown;
  events?: HarnessEvent[];
  metadata?: Record<string, unknown>;
}

export interface HarnessCommandRequest {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

export interface HarnessCommandResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
}

export interface HarnessApprovalRequest {
  gateId: string;
  message: string;
  captureResponse?: boolean;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export type HarnessApprovalDecision =
  | { decision: 'approve'; comment?: string; metadata?: Record<string, unknown> }
  | { decision: 'reject'; reason: string; metadata?: Record<string, unknown> };

export interface ProcessSandboxAdapter {
  resolve(request: SandboxExecutionRequest): Promise<SandboxExecutionHandle>;
}

export interface CoreProcessFactoryLike {
  create(options: CoreAgentProcessOptions): CoreAgentProcessLike;
}

export interface CoreAgentProcessOptions {
  prompt: string;
  cwd: string;
  provider?: string;
  model?: string;
  maxTurns?: number;
  sessionId?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, unknown>;
  systemPrefix?: string;
  effort?: string;
  images?: unknown[];
  env?: Record<string, string>;
  spawnClaudeCodeProcess?: (options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) => unknown;
}

export interface CoreAgentProcessLike {
  on(event: 'message', listener: (msg: unknown) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'exit', listener: (code: number | null) => void): this;
  removeAllListeners(event?: string): this;
  start(): void;
  kill(): Promise<void>;
  readonly exited: boolean;
}

export type HarnessRuntimeFailure = HarnessError;
