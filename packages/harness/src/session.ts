import { createAgent, type HarnessAgentDefinition, type HarnessAgentOptions } from './agent.js';
import { HarnessError, toHarnessError } from './errors.js';
import type { HarnessEvent, HarnessEventSink } from './events.js';
import { nowIso } from './events.js';
import type { HarnessRuntime, HarnessAgentResult } from './runtime.js';
import type { SandboxExecutionHandle, SandboxIntent } from './sandbox.js';
import type { HarnessTool, ToolRegistry } from './tools.js';

export interface CreateSessionOptions {
  agent: HarnessAgentDefinition | HarnessAgentOptions;
  runtime: HarnessRuntime;
  cwd: string;
  sessionId?: string;
  onEvent?: HarnessEventSink;
  tools?: readonly HarnessTool[];
  toolRegistry?: ToolRegistry;
  sandbox?: SandboxIntent;
  metadata?: Record<string, unknown>;
}

export interface PromptOptions {
  sessionId?: string;
  images?: unknown[];
  signal?: AbortSignal;
  tools?: readonly HarnessTool[];
  sandbox?: SandboxIntent;
  metadata?: Record<string, unknown>;
}

export class HarnessSession {
  readonly agent: HarnessAgentDefinition;
  readonly runtime: HarnessRuntime;
  readonly cwd: string;
  private providerSessionId?: string;
  private readonly onEvent?: HarnessEventSink;
  private readonly baseTools: readonly HarnessTool[];
  private readonly toolRegistry?: ToolRegistry;
  private readonly defaultSandbox?: SandboxIntent;
  private readonly metadata?: Record<string, unknown>;

  constructor(options: CreateSessionOptions) {
    if (!options.runtime?.spawnAgent) {
      throw new HarnessError('runtime_unavailable', 'A HarnessRuntime with spawnAgent is required');
    }
    if (!options.cwd?.trim()) {
      throw new HarnessError('invalid_runtime_request', 'Session cwd is required');
    }
    this.agent = isAgentDefinition(options.agent) ? options.agent : createAgent(options.agent);
    this.runtime = options.runtime;
    this.cwd = options.cwd;
    this.providerSessionId = options.sessionId;
    this.onEvent = options.onEvent;
    this.baseTools = Object.freeze([
      ...this.agent.tools,
      ...(options.tools ?? []),
      ...(options.toolRegistry?.list() ?? []),
    ]);
    this.toolRegistry = options.toolRegistry;
    this.defaultSandbox = options.sandbox;
    this.metadata = options.metadata;
  }

  get sessionId(): string | undefined {
    return this.providerSessionId;
  }

  async prompt(prompt: string, options: PromptOptions = {}): Promise<HarnessAgentResult> {
    if (!prompt?.trim()) {
      throw new HarnessError('invalid_runtime_request', 'Prompt text is required');
    }

    const tools = Object.freeze([...this.baseTools, ...(options.tools ?? [])]);
    await this.ensureToolExposure(tools);

    const sandbox = options.sandbox ?? this.defaultSandbox ?? this.agent.sandbox;
    const resolvedSandbox = await this.resolveSandboxIfNeeded(sandbox, options);

    await this.emit({
      type: 'session.started',
      timestamp: nowIso(),
      sessionId: options.sessionId ?? this.providerSessionId,
      prompt,
    });

    try {
      const result = await this.runtime.spawnAgent({
        agent: this.agent,
        prompt,
        cwd: resolvedSandbox?.cwd ?? this.cwd,
        sessionId: options.sessionId ?? this.providerSessionId,
        images: options.images,
        signal: options.signal,
        sandbox,
        resolvedSandbox,
        tools,
        onEvent: (event) => void this.emit(event),
        metadata: { ...this.metadata, ...options.metadata },
      });

      if (result.sessionId) this.providerSessionId = result.sessionId;
      return result;
    } catch (err) {
      const error = toHarnessError(err, 'agent_execution_failed', 'Agent execution failed');
      await this.emit({ type: 'session.error', timestamp: nowIso(), error });
      throw error;
    } finally {
      await resolvedSandbox?.cleanup?.();
    }
  }

  private async ensureToolExposure(tools: readonly HarnessTool[]): Promise<void> {
    if (tools.length === 0) return;
    if (this.runtime.capabilities?.toolExposure || this.runtime.exposeTools) return;
    throw new HarnessError(
      'unsupported_tool_exposure',
      `Runtime "${this.runtime.name ?? 'anonymous'}" cannot expose custom agent tools`,
    );
  }

  private async resolveSandboxIfNeeded(
    sandbox: SandboxIntent,
    options: PromptOptions,
  ): Promise<SandboxExecutionHandle | undefined> {
    if (sandbox.kind === 'local') return undefined;

    const supports =
      sandbox.kind === 'process'
        ? (this.runtime.capabilities?.processSandbox ?? !!this.runtime.resolveSandbox)
        : (this.runtime.capabilities?.runnerSandbox ?? !!this.runtime.resolveSandbox);

    if (!supports) {
      throw new HarnessError(
        'unsupported_sandbox_backend',
        `Runtime "${this.runtime.name ?? 'anonymous'}" does not support ${sandbox.kind} sandboxing`,
      );
    }
    if (!this.runtime.resolveSandbox) {
      throw new HarnessError(
        'unsupported_sandbox_backend',
        `Runtime "${this.runtime.name ?? 'anonymous'}" has no sandbox resolver`,
      );
    }

    const handle = await this.runtime.resolveSandbox({
      intent: sandbox,
      cwd: this.cwd,
      sessionId: options.sessionId ?? this.providerSessionId,
      metadata: options.metadata,
    });
    await this.emit({
      type: 'sandbox.resolved',
      timestamp: nowIso(),
      sandboxId: handle.id,
      backend: handle.kind,
      metadata: handle.metadata,
    });
    return handle;
  }

  private async emit(event: HarnessEvent): Promise<void> {
    await this.onEvent?.(event);
    await this.runtime.notify?.(event);
  }
}

export function createSession(options: CreateSessionOptions): HarnessSession {
  return new HarnessSession(options);
}

function isAgentDefinition(
  agent: HarnessAgentDefinition | HarnessAgentOptions,
): agent is HarnessAgentDefinition {
  return (
    typeof (agent as HarnessAgentDefinition).provider === 'string' &&
    Array.isArray((agent as HarnessAgentDefinition).allowedTools) &&
    Array.isArray((agent as HarnessAgentDefinition).disallowedTools) &&
    (agent as HarnessAgentDefinition).sandbox !== undefined
  );
}
