/**
 * BaseAgentProcess — abstract base class for all provider adapters.
 *
 * Extracts the common lifecycle boilerplate shared by SDKClaudeProcess,
 * CodexACPProcess, and GeminiACPProcess:
 *
 *   - AbortController + _exited flag
 *   - start() → runProcess() error wrapper
 *   - kill() with abort
 *   - Helper methods for emitting CLIMessage (init, result, error)
 *   - finalize() for consistent cleanup
 *
 * Each provider extends this and implements `runProcess()` with its
 * SDK-specific logic. Override `kill()` for provider-specific cleanup
 * (e.g., killing a child process).
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import type {
  CLIMessage,
  CLISystemMessage,
  CLIResultMessage,
  ClaudeProcessOptions,
} from './types.js';

export type ResultSubtype =
  | 'success'
  | 'error_max_turns'
  | 'error_during_execution'
  | 'error_max_budget_usd';

/**
 * Terminate a child process AND its entire descendant tree.
 *
 * ACP agents (and DeepAgent) spawn MCP servers as their own children, so
 * signaling only the immediate child (`child.kill()`) leaves those
 * grandchildren orphaned and resident — the dominant memory leak this guards
 * against. To reap the whole tree we rely on the child being spawned in its own
 * process group (`detached: true` on POSIX) and signal the group via the
 * negative pid; on Windows we use `taskkill /T`.
 *
 * SIGTERM is sent immediately; a SIGKILL escalation is scheduled after
 * `graceMs` for anything that ignored the term. The grace timer is unref'd so
 * it never keeps the runner alive.
 */
export function killProcessTree(child: ChildProcess, graceMs = 3000): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    return;
  }

  // POSIX: the child leads its own process group (spawned detached), so a
  // negative pid signals the agent and every descendant it spawned.
  const signalGroup = (sig: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      // ESRCH → group already gone; EPERM → not a group leader (spawned
      // without `detached`). Either way, fall back to the immediate pid.
      return false;
    }
  };

  if (!signalGroup('SIGTERM')) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }

  const timer = setTimeout(() => {
    if (!signalGroup('SIGKILL')) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }, graceMs);
  timer.unref?.();
}

export abstract class BaseAgentProcess extends EventEmitter {
  protected abortController = new AbortController();
  protected _exited = false;

  /** Promise representing the currently running turn, or null when idle. */
  private currentTurn: Promise<void> | null = null;
  /** Prompts (with optional per-turn images) queued while a turn was in flight. */
  private promptQueue: Array<{ prompt: string; images?: unknown[] }> = [];

  constructor(protected options: ClaudeProcessOptions) {
    super();
  }

  // ── IAgentProcess API (shared) ──────────────────────────────────

  start(): void {
    this.runProcess().catch((err) => {
      if (!this._exited) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async kill(): Promise<void> {
    this.abortController.abort();
  }

  get exited(): boolean {
    return this._exited;
  }

  // ── Protected helpers ───────────────────────────────────────────

  /** Whether the abort signal has been triggered. */
  protected get isAborted(): boolean {
    return this.abortController.signal.aborted;
  }

  /** Provider-specific run loop. Implement in subclass. */
  protected abstract runProcess(): Promise<void>;

  /**
   * Hook for ACP-based subclasses that hold a live ACP connection. Returning
   * a handle here opts the adapter into `steerPrompt` semantics — the base
   * class will issue `session/cancel` on the in-flight turn before queuing
   * the steered prompt. Adapters that can't cancel mid-turn should leave
   * this undefined; `steerPrompt` then degrades to a plain follow-up.
   */
  protected getCancellableSession?(): {
    sessionId: string;
    cancel: () => Promise<void>;
  } | null;

  /**
   * Steer: cancel the in-flight turn (if any) and send `prompt` on the same
   * session. Falls back to plain `enqueuePrompt` for adapters that don't
   * implement `getCancellableSession`. The cancelled turn still emits a
   * `result` CLIMessage (subtype mapped from `stopReason: 'cancelled'`),
   * so the queue lock releases naturally before the steered turn starts.
   */
  async steerPrompt(prompt: string, images?: unknown[]): Promise<void> {
    const handle = this.getCancellableSession?.();
    if (handle) {
      try {
        await handle.cancel();
      } catch (err) {
        // Best-effort: cancel may race against natural turn completion.
        // Don't fail the steer — the steered prompt still queues.
        if (!this.isAborted) {
          this.emit('error', err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
    return this.enqueuePrompt(prompt, images);
  }

  /**
   * Resolves when kill() is called (or immediately if already aborted).
   * Long-lived adapters await this inside runProcess() to keep the run
   * loop alive across multiple prompts on the same session.
   */
  protected awaitShutdown(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.abortController.signal.aborted) {
        resolve();
        return;
      }
      this.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  /**
   * Queue a prompt for execution and return as soon as it's accepted —
   * does NOT await turn completion. Turn progress and results flow through
   * 'message' / 'error' events on this EventEmitter.
   *
   * Why fire-and-forget: callers up the chain (HTTP `POST /messages`) would
   * otherwise block for the entire turn (potentially minutes), causing WS
   * tunnel timeouts and duplicate POSTs. The model's response is delivered
   * to clients via separate event channels regardless of when this resolves.
   *
   * Subclasses must implement `runOnePrompt(prompt)` for the per-turn work.
   */
  protected async enqueuePrompt(prompt: string, images?: unknown[]): Promise<void> {
    if (this._exited || this.isAborted) {
      throw new Error('Agent process has exited');
    }
    if (this.currentTurn) {
      this.promptQueue.push({ prompt, images });
      return;
    }
    this.startTurn(prompt, images);
  }

  private startTurn(prompt: string, images?: unknown[]): void {
    const turn = this.runOnePromptSafe(prompt, images);
    this.currentTurn = turn;
    turn.finally(() => {
      if (this.currentTurn === turn) {
        this.currentTurn = null;
      }
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this._exited || this.isAborted) return;
    if (this.currentTurn) return;
    const next = this.promptQueue.shift();
    if (!next) return;
    this.startTurn(next.prompt, next.images);
  }

  /**
   * Wrapper around `runOnePrompt` that swallows errors after emitting them
   * via the standard error-handling path, so a failed turn doesn't poison
   * the queue.
   */
  private async runOnePromptSafe(prompt: string, images?: unknown[]): Promise<void> {
    try {
      if (!this.runOnePrompt) {
        throw new Error('Adapter does not implement runOnePrompt — multi-turn not supported');
      }
      await this.runOnePrompt(prompt, images);
    } catch (err) {
      if (!this.isAborted) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * Provider-specific per-turn work. Multi-turn adapters override this and
   * are expected to: reset per-turn state, call the provider's prompt API
   * on the live connection, and emit a `result` CLIMessage.
   *
   * `images` are scoped to this single turn — callers pass `this.options.images`
   * for the initial turn and follow-up images via `sendPrompt`/`steerPrompt`.
   */
  protected runOnePrompt?(prompt: string, images?: unknown[]): Promise<void>;

  /** Emit a system:init CLIMessage. */
  protected emitInit(sessionId: string, tools: string[], model: string, cwd: string): void {
    const msg: CLISystemMessage = {
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      tools,
      model,
      cwd,
    };
    this.emit('message', msg);
  }

  /**
   * Emit a synthetic assistant message carrying token usage so the runtime can
   * broadcast `agent:context_usage` to the client context ring. ACP providers
   * often surface usage via `sessionUpdate: "usage_update"` or
   * `PromptResponse.usage` rather than on streamed assistant chunks.
   */
  protected emitContextUsageMessage(params: {
    inputTokens: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): void {
    const inputTokens = params.inputTokens;
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return;

    this.emit('message', {
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [],
        usage: {
          input_tokens: inputTokens,
          output_tokens: params.outputTokens ?? 0,
          cache_read_input_tokens: params.cacheReadTokens ?? 0,
          cache_creation_input_tokens: params.cacheWriteTokens ?? 0,
        },
      },
    } as CLIMessage);
  }

  /** Handle ACP `sessionUpdate: "usage_update"`. Returns true when handled. */
  protected handleAcpUsageUpdate(update: { sessionUpdate?: string; used?: number }): boolean {
    if (update.sessionUpdate !== 'usage_update') return false;
    if (typeof update.used === 'number') {
      this.emitContextUsageMessage({ inputTokens: update.used });
    }
    return true;
  }

  /** Map ACP `PromptResponse.usage` (camelCase) to a context-usage CLIMessage. */
  protected emitAcpPromptResponseUsage(usage: unknown): void {
    if (!usage || typeof usage !== 'object') return;
    const u = usage as Record<string, unknown>;
    this.emitContextUsageMessage({
      inputTokens: (u.inputTokens as number | undefined) ?? 0,
      outputTokens: (u.outputTokens as number | undefined) ?? 0,
      cacheReadTokens:
        (u.cachedReadTokens as number | undefined) ??
        (u.cacheReadTokens as number | undefined) ??
        0,
      cacheWriteTokens:
        (u.cachedWriteTokens as number | undefined) ??
        (u.cacheWriteTokens as number | undefined) ??
        0,
    });
  }

  /** Emit a result CLIMessage. */
  protected emitResult(params: {
    sessionId: string;
    subtype: ResultSubtype;
    startTime: number;
    numTurns: number;
    totalCost: number;
    result?: string;
    errors?: string[];
  }): void {
    const msg: CLIResultMessage = {
      type: 'result',
      subtype: params.subtype,
      is_error: params.subtype !== 'success',
      duration_ms: Date.now() - params.startTime,
      num_turns: params.numTurns,
      result: params.result,
      total_cost_usd: params.totalCost,
      session_id: params.sessionId,
      ...(params.errors ? { errors: params.errors } : {}),
    };
    this.emit('message', msg);
  }

  /**
   * Emit a provider error as a tool_use + tool_result pair so it renders
   * as a collapsible tool card in the UI with full history.
   */
  protected emitErrorToolCall(errorText: string): void {
    const toolCallId = randomUUID();
    // tool_use (assistant)
    this.emit('message', {
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [
          {
            type: 'tool_use',
            id: toolCallId,
            name: 'ProviderError',
            input: { error: errorText },
          },
        ],
      },
    } as CLIMessage);
    // tool_result (user) — mark as error
    this.emit('message', {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: errorText,
            is_error: true,
          },
        ],
      },
    } as CLIMessage);
  }

  /**
   * Extract a human-readable error message from an ACP RequestError or
   * generic Error. ACP RequestError objects carry a `.data.details` field
   * with the actionable message, while `.message` is just "Internal error".
   *
   * The raw `details` string often contains the full API error dump including
   * JSON metadata (quota violations, retry info, etc.). We extract just the
   * human-readable parts so the UI shows a clean message.
   */
  protected extractErrorMessage(err: unknown): string {
    if (err == null) return 'Unknown error';
    if (typeof err === 'string') return this.cleanErrorDetails(err);
    if (typeof err !== 'object') return String(err);

    const e = err as Record<string, unknown>;
    const base = typeof e.message === 'string' ? e.message : String(err);

    // ACP RequestError: { code, message, data: { details } }
    if (e.data && typeof e.data === 'object') {
      const details = (e.data as Record<string, unknown>).details;
      if (typeof details === 'string') {
        return this.cleanErrorDetails(details);
      }
    }

    return base;
  }

  /**
   * Clean up raw error details by extracting the human-readable parts
   * and stripping JSON metadata blobs, "For more information" boilerplate, etc.
   */
  private cleanErrorDetails(raw: string): string {
    let cleaned = raw
      // Strip trailing JSON array blobs like [{...},{...}] that APIs append
      .replace(/\s*\[\{[^]*\}\]\s*$/, '')
      // Strip "For more information..." / "To monitor..." boilerplate sentences
      .replace(/\.\s*For more information[^.]*\./gi, '.')
      .replace(/\.\s*To monitor[^.]*\./gi, '.')
      .trim();

    // Extract the main error line and any "Please retry" / quota info
    const lines = cleaned
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return raw;

    const mainLine = lines[0];
    const retryLine = lines.find((l) => /please retry in/i.test(l));
    const quotaLine = lines.find((l) => /quota exceeded/i.test(l));

    const parts = [mainLine];
    if (quotaLine && quotaLine !== mainLine) parts.push(quotaLine);
    if (retryLine && retryLine !== mainLine) parts.push(retryLine);

    return parts.join('\n');
  }

  /**
   * Parse stderr output and extract actionable error messages.
   * Returns a formatted error string if an error is found, null otherwise.
   *
   * Handles:
   * - ACP JSON-RPC errors with `data.details` (rate limits, auth failures)
   * - Generic "[Provider Error]:" patterns
   */
  protected parseStderrError(raw: string): string | null {
    // ACP JSON-RPC error pattern: "Error handling request ... { code, message, data: { details } }"
    const detailsMatch = raw.match(/details:\s*'([\s\S]*?)'\s*\n?\s*\}/);
    if (detailsMatch) {
      const details = detailsMatch[1];
      const firstLine = details.split('\n')[0].trim();
      const retryMatch = details.match(/Please retry in ([\d.]+s)/);
      const retryInfo = retryMatch ? `\n\nRetry in ${retryMatch[1]}.` : '';
      return `**Error from provider:** ${firstLine}${retryInfo}`;
    }

    // Generic error lines (e.g., "[GoogleGenerativeAI Error]: ...")
    const errorLineMatch = raw.match(/\[(\w+) Error\]:\s*(.*)/);
    if (errorLineMatch) {
      return `**Error from provider:** ${errorLineMatch[0].trim()}`;
    }

    // If it contains "error" (case-insensitive) and looks like an actual error, surface it
    if (/\berror\b/i.test(raw) && raw.length < 2000) {
      return `**Provider stderr:** ${raw}`;
    }

    return null;
  }

  /**
   * Mark the process as exited and emit the 'exit' event.
   * Call this in the `finally` block of `runProcess()`.
   */
  protected finalize(): void {
    this._exited = true;
    this.emit('exit', this.isAborted ? null : 0);
  }
}
