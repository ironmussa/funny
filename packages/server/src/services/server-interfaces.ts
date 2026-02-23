/**
 * Server-specific dependency injection interfaces.
 * These stay in the server package because they reference DB operations and WebSocket events.
 *
 * Interfaces are split by responsibility (ISP):
 *   - IThreadQuery:       Thread CRUD / lookups
 *   - IMessageRepository: Message persistence
 *   - IToolCallRepository: Tool call persistence
 *   - IThreadManager:     Combined interface (backward-compatible)
 */

import type { WSEvent } from '@funny/shared';

// ── Thread query / mutation ────────────────────────────────────

export interface IThreadQuery {
  getThread(id: string): { sessionId: string | null;[key: string]: any } | undefined;
  updateThread(id: string, updates: Record<string, any>): void;
  getThreadWithMessages(id: string): { messages: any[];[key: string]: any } | null;
}

// ── Message repository ──────────────────────────────────────────

export interface IMessageRepository {
  insertMessage(data: {
    threadId: string;
    role: string;
    content: string;
    images?: string | null;
    model?: string | null;
    permissionMode?: string | null;
    author?: string | null;
  }): string;
  updateMessage(id: string, content: string): void;
}

// ── Tool call repository ────────────────────────────────────────

export interface IToolCallRepository {
  insertToolCall(data: {
    messageId: string;
    name: string;
    input: string;
    author?: string | null;
  }): string;
  updateToolCallOutput(id: string, output: string): void;
  findToolCall(messageId: string, name: string, input: string): { id: string } | undefined;
  getToolCall(id: string): { id: string; name: string; input: string | null; output?: string | null } | undefined;
}

// ── Combined interface (backward-compatible) ────────────────────

export interface IThreadManager extends IThreadQuery, IMessageRepository, IToolCallRepository {}

// ── WebSocket broker ────────────────────────────────────────────

export interface IWSBroker {
  emit(event: WSEvent): void;
  emitToUser(userId: string, event: WSEvent): void;
}
