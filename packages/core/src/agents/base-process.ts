/**
 * BaseAgentProcess — abstract base class for all provider adapters.
 *
 * Extracts the common lifecycle boilerplate shared by SDKClaudeProcess,
 * CodexProcess, and GeminiACPProcess:
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

import { EventEmitter } from 'events';

import type { CLISystemMessage, CLIResultMessage, ClaudeProcessOptions } from './types.js';

export type ResultSubtype =
  | 'success'
  | 'error_max_turns'
  | 'error_during_execution'
  | 'error_max_budget_usd';

export abstract class BaseAgentProcess extends EventEmitter {
  protected abortController = new AbortController();
  protected _exited = false;

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
   * Mark the process as exited and emit the 'exit' event.
   * Call this in the `finally` block of `runProcess()`.
   */
  protected finalize(): void {
    this._exited = true;
    this.emit('exit', this.isAborted ? null : 0);
  }
}
