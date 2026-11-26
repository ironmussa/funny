import type { JsonObject, JsonValue } from '@funny/shared/json';
import type { z, ZodTypeAny } from 'zod';

import type { HarnessEvent, HarnessEventSink } from './events.js';
import type {
  SandboxExecutionHandle,
  SandboxExecutionRequest,
  SandboxIntent,
  SpawnClaudeCodeProcess,
} from './sandbox.js';

export type HarnessPermissionMode = 'plan' | 'autoEdit' | 'confirmEdit' | (string & {});

export interface ToolExecutionContext {
  cwd?: string;
  runtime?: HarnessRuntime;
  metadata?: JsonObject;
}

export interface HarnessToolDefinition<TSchema extends ZodTypeAny, TResult> {
  name: string;
  description: string;
  inputSchema: TSchema;
  handler: (input: z.infer<TSchema>, context: ToolExecutionContext) => TResult | Promise<TResult>;
  metadata?: JsonObject;
}

/** What a tool takes: the JSON an agent sends, checked by the tool's `inputSchema`. */
export type ToolInput = JsonValue;

/** What a tool returns to its caller: JSON, or nothing. */
export type ToolResult = JsonValue | undefined;

export interface HarnessTool<TSchema extends ZodTypeAny = ZodTypeAny, TResult = ToolResult> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TSchema;
  readonly handler: (
    input: z.infer<TSchema>,
    context: ToolExecutionContext,
  ) => TResult | Promise<TResult>;
  readonly metadata?: Readonly<JsonObject>;
}

export interface HarnessAgentOptions {
  name?: string;
  provider?: string;
  model?: string;
  instructions: string;
  permissionMode?: HarnessPermissionMode;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  tools?: readonly HarnessTool[];
  mcpServers?: Record<string, JsonObject>;
  maxTurns?: number;
  effort?: string;
  sandbox?: SandboxIntent;
  metadata?: JsonObject;
}

export interface HarnessAgentDefinition {
  readonly name: string;
  readonly provider: string;
  readonly model?: string;
  readonly instructions: string;
  readonly permissionMode?: HarnessPermissionMode;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly tools: readonly HarnessTool[];
  readonly mcpServers?: Readonly<Record<string, JsonObject>>;
  readonly maxTurns?: number;
  readonly effort?: string;
  readonly sandbox: SandboxIntent;
  readonly metadata?: Readonly<JsonObject>;
}

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
  mcpServers?: Record<string, JsonObject>;
  metadata?: JsonObject;
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
  metadata?: JsonObject;
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
  metadata?: JsonObject;
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
  metadata?: JsonObject;
}

export type HarnessApprovalDecision =
  | { decision: 'approve'; comment?: string; metadata?: JsonObject }
  | { decision: 'reject'; reason: string; metadata?: JsonObject };

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
  mcpServers?: Record<string, JsonObject>;
  systemPrefix?: string;
  effort?: string;
  images?: unknown[];
  env?: Record<string, string>;
  spawnClaudeCodeProcess?: SpawnClaudeCodeProcess;
}

/**
 * A message an agent process emits (an SDK stream message, keyed by `type`).
 * The harness reads the fields it knows and keeps the message as the event's `raw`.
 */
export interface CoreAgentMessage {
  readonly type?: string;
}

export interface CoreAgentProcessLike {
  on(event: 'message', listener: (msg: CoreAgentMessage) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'exit', listener: (code: number | null) => void): this;
  removeAllListeners(event?: string): this;
  start(): void;
  kill(): Promise<void>;
  readonly exited: boolean;
}
