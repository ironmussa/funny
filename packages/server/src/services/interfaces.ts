/**
 * Dependency injection interfaces for agent-runner.
 * These decouple agent-runner from concrete singletons, enabling unit testing.
 */

import type { WSEvent } from '@a-parallel/shared';
import type { CLIMessage, ClaudeProcessOptions } from './claude-process.js';

// ── Thread Manager subset used by agent-runner ──────────────────

export interface IThreadManager {
  getThread(id: string): { sessionId: string | null; [key: string]: any } | undefined;
  updateThread(id: string, updates: Record<string, any>): void;
  insertMessage(data: {
    threadId: string;
    role: string;
    content: string;
    images?: string | null;
  }): string;
  updateMessage(id: string, content: string): void;
  insertToolCall(data: {
    messageId: string;
    name: string;
    input: string;
  }): string;
  updateToolCallOutput(id: string, output: string): void;
  findToolCall(messageId: string, name: string, input: string): { id: string } | undefined;
}

// ── WebSocket broker ────────────────────────────────────────────

export interface IWSBroker {
  emit(event: WSEvent): void;
  emitToUser(userId: string, event: WSEvent): void;
}

// ── Claude process factory ──────────────────────────────────────

export interface IClaudeProcess {
  on(event: 'message', listener: (msg: CLIMessage) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'exit', listener: (code: number | null) => void): this;
  start(): void;
  kill(): Promise<void>;
  readonly exited: boolean;
}

export interface IClaudeProcessFactory {
  create(options: ClaudeProcessOptions): IClaudeProcess;
}
