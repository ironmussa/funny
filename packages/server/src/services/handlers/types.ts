/**
 * Reactive Handler types — generic interface for self-describing,
 * declarative event handlers that receive dependencies via injection.
 */

import type { ThreadEventMap } from '../thread-event-bus.js';

// ── Service Context ─────────────────────────────────────────────

/**
 * Injected into every handler action. Decouples handlers from
 * concrete module imports — handlers never import thread-manager,
 * agent-runner, etc. directly.
 */
export interface HandlerServiceContext {
  // Thread operations
  getThread(id: string): Record<string, any> | undefined;
  updateThread(id: string, updates: Record<string, any>): void;
  insertComment(data: { threadId: string; userId: string; source: string; content: string }): any;

  // Project operations
  getProject(id: string): Record<string, any> | undefined;

  // WebSocket
  emitToUser(userId: string, event: any): void;
  broadcast(event: any): void;

  // Agent
  startAgent(
    threadId: string,
    prompt: string,
    cwd: string,
    model?: string,
    permissionMode?: string,
  ): Promise<void>;

  // Git
  getGitStatusSummary(cwd: string, baseBranch?: string, mainRepoPath?: string): Promise<any>;
  deriveGitSyncState(summary: any): string;
  invalidateGitStatusCache(projectId: string): void;

  // Thread events
  saveThreadEvent(threadId: string, type: string, data: Record<string, unknown>): Promise<void>;

  // Logging
  log(message: string): void;
}

// ── Event Handler ───────────────────────────────────────────────

/**
 * A declarative, self-describing event handler.
 *
 * Generic over K (the event name) so that filter/action receive
 * the correct typed payload at compile time.
 */
export interface EventHandler<K extends keyof ThreadEventMap = keyof ThreadEventMap> {
  /** Unique name for logging/debugging */
  name: string;

  /** Which ThreadEventBus event this handler listens to */
  event: K;

  /** Optional predicate — return true to run the action. If omitted, action always runs. */
  filter?: (payload: Parameters<ThreadEventMap[K]>[0], ctx: HandlerServiceContext) => boolean;

  /** The action to perform. Receives the typed event payload and the service context. */
  action: (
    payload: Parameters<ThreadEventMap[K]>[0],
    ctx: HandlerServiceContext,
  ) => void | Promise<void>;
}
