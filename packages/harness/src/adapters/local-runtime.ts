import { spawn as nodeSpawn } from 'node:child_process';

import { HarnessError, toHarnessError } from '../errors.js';
import type { HarnessEvent } from '../events.js';
import { nowIso } from '../events.js';
import type {
  CoreAgentProcessLike,
  CoreAgentProcessOptions,
  CoreProcessFactoryLike,
  HarnessAgentRequest,
  HarnessAgentResult,
  HarnessCommandRequest,
  HarnessCommandResult,
  HarnessRuntime,
  ProcessSandboxAdapter,
} from '../runtime.js';
import type { SandboxExecutionHandle, SandboxExecutionRequest } from '../sandbox.js';

export interface LocalRuntimeOptions {
  processFactory?: CoreProcessFactoryLike;
  processSandbox?: ProcessSandboxAdapter;
  runnerSandboxResolver?: (request: SandboxExecutionRequest) => Promise<SandboxExecutionHandle>;
  env?: Record<string, string>;
  name?: string;
}

export function createLocalRuntime(options: LocalRuntimeOptions = {}): HarnessRuntime {
  return {
    name: options.name ?? 'local',
    capabilities: {
      commands: true,
      notifications: true,
      processSandbox: !!options.processSandbox,
      runnerSandbox: !!options.runnerSandboxResolver,
      cancellation: true,
      toolExposure: false,
    },

    async resolveSandbox(request) {
      if (request.intent.kind === 'local') {
        return { kind: 'local', cwd: request.cwd };
      }
      if (request.intent.kind === 'process') {
        if (!options.processSandbox) {
          throw new HarnessError(
            'unsupported_sandbox_backend',
            'Local runtime has no process sandbox adapter',
          );
        }
        return options.processSandbox.resolve(request);
      }
      if (!options.runnerSandboxResolver) {
        throw new HarnessError(
          'unsupported_sandbox_backend',
          'Local runtime has no runner sandbox resolver',
        );
      }
      return options.runnerSandboxResolver(request);
    },

    async spawnAgent(request) {
      if (request.tools.length > 0) {
        throw new HarnessError(
          'unsupported_tool_exposure',
          'Local runtime does not expose custom tools to agents yet',
        );
      }
      const processFactory = options.processFactory ?? (await loadDefaultProcessFactory());
      return runCoreAgent(processFactory, request, options.env);
    },

    async runCommand(request) {
      return runLocalCommand(request);
    },

    notify() {
      // Local runtime has no durable notification sink by default.
    },
  };
}

export interface SandboxManagerLike {
  startSandbox(options: {
    requestId: string;
    worktreePath: string;
    env?: Record<string, string>;
  }): Promise<unknown>;
  createSpawnFn(requestId: string): SandboxExecutionHandle['spawnClaudeCodeProcess'];
  stopSandbox(requestId: string): Promise<void>;
}

export function createSandboxManagerProcessAdapter(
  manager: SandboxManagerLike,
): ProcessSandboxAdapter {
  return {
    async resolve(request) {
      if (request.intent.kind !== 'process') {
        throw new HarnessError('unsupported_sandbox_backend', 'Process sandbox intent is required');
      }
      const requestId = request.intent.requestId ?? request.sessionId ?? makeId('sandbox');
      const worktreePath = request.intent.worktreePath ?? request.cwd;
      await manager.startSandbox({
        requestId,
        worktreePath,
        env: request.intent.env,
      });
      return {
        id: requestId,
        kind: 'process',
        cwd: '/workspace',
        spawnClaudeCodeProcess: manager.createSpawnFn(requestId),
        metadata: { isolation: request.intent.isolation },
        cleanup: () => manager.stopSandbox(requestId),
      };
    },
  };
}

async function runCoreAgent(
  processFactory: CoreProcessFactoryLike,
  request: HarnessAgentRequest,
  env?: Record<string, string>,
): Promise<HarnessAgentResult> {
  const events: HarnessEvent[] = [];
  const emit = (event: HarnessEvent) => {
    events.push(event);
    void request.onEvent?.(event);
  };

  const exposed = request.resolvedSandbox;
  if (request.sandbox.kind === 'process' && !exposed?.spawnClaudeCodeProcess) {
    throw new HarnessError(
      'unsupported_sandbox_backend',
      'Process sandbox did not provide spawnClaudeCodeProcess',
    );
  }

  const options: CoreAgentProcessOptions = {
    prompt: request.prompt,
    cwd: exposed?.cwd ?? request.cwd,
    provider: request.agent.provider,
    model: request.agent.model,
    maxTurns: request.agent.maxTurns,
    sessionId: request.sessionId,
    permissionMode: request.agent.permissionMode,
    allowedTools: [...request.agent.allowedTools],
    disallowedTools: [...request.agent.disallowedTools],
    mcpServers: request.agent.mcpServers as Record<string, unknown> | undefined,
    systemPrefix: request.agent.instructions,
    effort: request.agent.effort,
    images: request.images,
    env: { ...env },
    spawnClaudeCodeProcess: exposed?.spawnClaudeCodeProcess,
  };

  const proc = processFactory.create(options);
  return waitForProcess(proc, request.signal, emit);
}

function waitForProcess(
  proc: CoreAgentProcessLike,
  signal: AbortSignal | undefined,
  emit: (event: HarnessEvent) => void,
): Promise<HarnessAgentResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      proc.removeAllListeners('message');
      proc.removeAllListeners('error');
      proc.removeAllListeners('exit');
      fn();
    };

    const onAbort = () => {
      void proc.kill();
      settle(() =>
        reject(new HarnessError('agent_execution_failed', 'Agent execution aborted by signal')),
      );
    };

    const onMessage = (msg: unknown) => {
      for (const event of normalizeCoreMessage(msg)) emit(event);
      if (isResultMessage(msg)) {
        const errors = Array.isArray(msg.errors) ? msg.errors.join('\n') : undefined;
        settle(() =>
          resolve({
            ok: !msg.is_error && msg.subtype === 'success',
            output: msg.result,
            error: msg.is_error ? (errors ?? msg.result ?? msg.subtype) : undefined,
            sessionId: msg.session_id,
            costUsd: msg.total_cost_usd,
            durationMs: msg.duration_ms,
            raw: msg,
          }),
        );
      }
    };

    const onError = (err: Error) => {
      settle(() =>
        reject(toHarnessError(err, 'agent_execution_failed', 'Agent process emitted an error')),
      );
    };

    const onExit = (code: number | null) => {
      settle(() =>
        reject(
          new HarnessError(
            'agent_execution_failed',
            `Agent process exited before producing a result${code === null ? '' : ` (code ${code})`}`,
            { metadata: { exitCode: code } },
          ),
        ),
      );
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('message', onMessage);
    proc.on('error', onError);
    proc.on('exit', onExit);
    proc.start();
  });
}

function normalizeCoreMessage(msg: unknown): HarnessEvent[] {
  if (!isRecord(msg)) {
    return [{ type: 'session.raw', timestamp: nowIso(), raw: msg }];
  }

  if (msg.type === 'system') {
    return [
      {
        type: 'session.message',
        timestamp: nowIso(),
        role: 'system',
        text: 'Agent session initialized',
        raw: msg,
      },
    ];
  }

  if (msg.type === 'assistant' && isRecord(msg.message)) {
    const events: HarnessEvent[] = [];
    const content = Array.isArray(msg.message.content) ? msg.message.content : [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === 'text') {
        events.push({
          type: 'session.message',
          timestamp: nowIso(),
          role: 'assistant',
          text: typeof part.text === 'string' ? part.text : '',
          raw: msg,
        });
      } else if (part.type === 'tool_use') {
        events.push({
          type: 'session.tool_call',
          timestamp: nowIso(),
          id: typeof part.id === 'string' ? part.id : undefined,
          name: typeof part.name === 'string' ? part.name : 'unknown',
          input: part.input,
          raw: msg,
        });
      }
    }
    return events.length ? events : [{ type: 'session.raw', timestamp: nowIso(), raw: msg }];
  }

  if (isResultMessage(msg)) {
    return [
      {
        type: 'session.completed',
        timestamp: nowIso(),
        sessionId: msg.session_id,
        output: msg.result,
        raw: msg,
      },
    ];
  }

  return [{ type: 'session.raw', timestamp: nowIso(), raw: msg }];
}

function isResultMessage(msg: unknown): msg is {
  type: 'result';
  subtype: string;
  is_error: boolean;
  duration_ms: number;
  result?: string;
  total_cost_usd: number;
  session_id: string;
  errors?: string[];
} {
  return isRecord(msg) && msg.type === 'result' && typeof msg.session_id === 'string';
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

async function runLocalCommand(request: HarnessCommandRequest): Promise<HarnessCommandResult> {
  return new Promise((resolve) => {
    const child = nodeSpawn(request.command, {
      cwd: request.cwd,
      shell: true,
      env: { ...process.env, ...request.env },
      signal: request.signal,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout =
      request.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
          }, request.timeoutMs)
        : undefined;

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout);
      resolve({ ok: false, stdout, stderr, error: err.message });
    });
    child.on('exit', (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({
        ok: code === 0 && !timedOut,
        stdout,
        stderr,
        exitCode: code ?? undefined,
        error: timedOut ? 'Command timed out' : code === 0 ? undefined : stderr || `Exit ${code}`,
      });
    });
  });
}

function makeId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

async function loadDefaultProcessFactory(): Promise<CoreProcessFactoryLike> {
  const specifier = '@funny/core/agents';
  const mod = (await import(specifier)) as { defaultProcessFactory: CoreProcessFactoryLike };
  return mod.defaultProcessFactory;
}
