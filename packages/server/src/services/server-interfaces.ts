/**
 * Server-specific dependency injection interfaces.
 * These stay in the server package because they reference DB operations and WebSocket events.
 */

import type { WSEvent } from '@funny/shared';

// ── Thread Manager subset used by agent-runner ──────────────────

export interface IThreadManager {
  getThread(id: string): { sessionId: string | null;[key: string]: any } | undefined;
  updateThread(id: string, updates: Record<string, any>): void;
  insertMessage(data: {
    threadId: string;
    role: string;
    content: string;
    images?: string | null;
    model?: string | null;
    permissionMode?: string | null;
  }): string;
  updateMessage(id: string, content: string): void;
  insertToolCall(data: {
    messageId: string;
    name: string;
    input: string;
  }): string;
  updateToolCallOutput(id: string, output: string): void;
  findToolCall(messageId: string, name: string, input: string): { id: string } | undefined;
  getToolCall(id: string): { id: string; name: string; input: string | null; output?: string | null } | undefined;
  getThreadWithMessages(id: string): { messages: any[];[key: string]: any } | null;
}

// ── WebSocket broker ────────────────────────────────────────────

export interface IWSBroker {
  emit(event: WSEvent): void;
  emitToUser(userId: string, event: WSEvent): void;
}
