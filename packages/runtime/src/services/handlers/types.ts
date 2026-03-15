/**
 * @domain subdomain: Shared Kernel
 * @domain type: port
 * @domain layer: domain
 *
 * Generic interface for self-describing, declarative event handlers.
 */

import type { GitStatusSummary } from '@funny/core/git';
import type { GitSyncState, ImageAttachment } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

import type { ThreadEventMap } from '../thread-event-bus.js';

/** Queued follow-up message entry (inlined from deleted message-queue module). */
interface QueueEntry {
  id: string;
  threadId: string;
  content: string;
  provider: string | null;
  model: string | null;
  permissionMode: string | null;
  images: string | null;
  allowedTools: string | null;
  disallowedTools: string | null;
  fileReferences: string | null;
  sortOrder: number;
  createdAt: string;
}

interface HandlerThread {
  id: string;
  projectId: string;
  userId: string;
  stage?: string | null;
  model?: string | null;
  provider?: string | null;
  permissionMode?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  worktreePath?: string | null;
  mergedAt?: string | null;
}

interface HandlerProject {
  id: string;
  path: string;
  followUpMode?: string;
}

// ── Service Context ─────────────────────────────────────────────

/**
 * Injected into every handler action. Decouples handlers from
 * concrete module imports — handlers never import thread-manager,
 * agent-runner, etc. directly.
 */
export interface HandlerServiceContext {
  // Thread operations
  getThread(id: string): HandlerThread | undefined | Promise<HandlerThread | undefined>;
  updateThread(id: string, updates: Record<string, any>): void | Promise<void>;
  insertComment(data: {
    threadId: string;
    userId: string;
    source: string;
    content: string;
  }): any | Promise<any>;

  // Project operations
  getProject(id: string): HandlerProject | undefined | Promise<HandlerProject | undefined>;

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
    images?: ImageAttachment[],
    disallowedTools?: string[],
    allowedTools?: string[],
    provider?: string,
  ): Promise<void>;

  // Git
  getGitStatusSummary(
    cwd: string,
    baseBranch?: string,
    mainRepoPath?: string,
  ): ResultAsync<GitStatusSummary, DomainError>;
  deriveGitSyncState(summary: GitStatusSummary): GitSyncState;
  invalidateGitStatusCache(projectId: string): void;

  // Thread events
  saveThreadEvent(threadId: string, type: string, data: Record<string, unknown>): Promise<void>;

  // Message queue
  dequeueMessage(threadId: string): QueueEntry | null | Promise<QueueEntry | null>;
  queueCount(threadId: string): number | Promise<number>;
  peekMessage(threadId: string): QueueEntry | null | Promise<QueueEntry | null>;

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
  filter?: (
    payload: Parameters<ThreadEventMap[K]>[0],
    ctx: HandlerServiceContext,
  ) => boolean | Promise<boolean>;

  /** The action to perform. Receives the typed event payload and the service context. */
  action: (
    payload: Parameters<ThreadEventMap[K]>[0],
    ctx: HandlerServiceContext,
  ) => void | Promise<void>;
}
