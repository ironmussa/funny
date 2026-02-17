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
  start(): void;
  kill(): Promise<void>;
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
