/**
 * Provider-agnostic agent process interfaces.
 * These are portable — no server-specific dependencies (no DB, WebSocket, HTTP).
 */

import type { AgentProvider } from '@funny/shared';

import type { CLIMessage, ClaudeProcessOptions } from './types.js';

// ── Agent process (provider-agnostic) ───────────────────────────

export interface IAgentProcess {
  on(event: 'message', listener: (msg: CLIMessage) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'exit', listener: (code: number | null) => void): this;
  /**
   * Emitted when the underlying provider session becomes permanently
   * unusable for resume (e.g. a poisoned `thinking` block that the API
   * rejects on every continuation). The orchestrator responds by clearing
   * the persisted sessionId so the next message rebuilds context instead of
   * resuming the broken session.
   */
  on(event: 'session-invalidated', listener: () => void): this;
  removeAllListeners(event?: string): this;
  start(): void;
  kill(): Promise<void>;
  /**
   * Send a follow-up prompt on the same long-lived process. Only set by
   * adapters that support multi-turn (e.g., ACP-based providers that keep
   * the child process and ACP session alive across turns). When undefined,
   * the orchestrator must respawn the process to issue another prompt.
   *
   * `images` are attachments scoped to this single turn. Adapters forward
   * them only when the agent advertised `promptCapabilities.image`.
   *
   * Implementations should queue if a turn is already in flight.
   */
  sendPrompt?(prompt: string, images?: unknown[]): Promise<void>;
  /**
   * Cancel the in-flight turn (if any) and send a new prompt on the same
   * session. Implemented by ACP adapters that can call `session/cancel`.
   * The pending `prompt()` resolves with `stopReason: 'cancelled'`, the
   * turn lock releases, and the new prompt runs on the same warm session.
   *
   * `images` are attachments scoped to this single turn. Adapters forward
   * them only when the agent advertised `promptCapabilities.image`.
   *
   * Cancellation happens between tool calls — a tool already executing
   * runs to completion before the agent honors the cancel.
   */
  steerPrompt?(prompt: string, images?: unknown[]): Promise<void>;
  readonly exited: boolean;
}

/** @deprecated Use IAgentProcess instead */
export type IClaudeProcess = IAgentProcess;

export interface AgentProcessOptions extends ClaudeProcessOptions {
  provider?: AgentProvider;
}

export interface IAgentProcessFactory {
  create(options: AgentProcessOptions): IAgentProcess;
}

/** @deprecated Use IAgentProcessFactory instead */
export type IClaudeProcessFactory = IAgentProcessFactory;
