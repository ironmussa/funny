/**
 * ThreadEventBus — server-side lifecycle event bus for thread/agent events.
 *
 * Emitters: routes/threads.ts, agent-runner.ts, agent-message-handler.ts
 * Subscribers: handlers/comment-handler.ts, future reactive handlers
 */

import { EventEmitter } from 'events';
import type { ThreadStage, ThreadStatus, AgentProvider, AgentModel } from '@funny/shared';

// ── Event payloads ────────────────────────────────────────────────

export interface ThreadLifecycleContext {
  threadId: string;
  projectId: string;
  userId: string;
  worktreePath: string | null;
  cwd: string;
}

export interface ThreadCreatedEvent extends ThreadLifecycleContext {
  stage: ThreadStage;
  status: ThreadStatus;
  initialPrompt?: string;
}

export interface ThreadStageChangedEvent extends ThreadLifecycleContext {
  fromStage: ThreadStage | null;
  toStage: ThreadStage;
}

export interface ThreadDeletedEvent {
  threadId: string;
  projectId: string;
  userId: string;
  worktreePath: string | null;
}

export interface AgentStartedEvent extends ThreadLifecycleContext {
  model: AgentModel;
  provider: AgentProvider;
}

export interface AgentCompletedEvent extends ThreadLifecycleContext {
  status: 'completed' | 'failed' | 'stopped';
  cost: number;
}

// ── Event map ─────────────────────────────────────────────────────

export interface ThreadEventMap {
  'thread:created': (event: ThreadCreatedEvent) => void;
  'thread:stage-changed': (event: ThreadStageChangedEvent) => void;
  'thread:deleted': (event: ThreadDeletedEvent) => void;
  'agent:started': (event: AgentStartedEvent) => void;
  'agent:completed': (event: AgentCompletedEvent) => void;
}

// ── Typed EventEmitter ────────────────────────────────────────────

export class ThreadEventBus extends EventEmitter {
  override emit<K extends keyof ThreadEventMap>(
    event: K,
    ...args: Parameters<ThreadEventMap[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof ThreadEventMap>(
    event: K,
    listener: ThreadEventMap[K],
  ): this {
    return super.on(event, listener as (...args: any[]) => void);
  }
}

// Singleton
export const threadEventBus = new ThreadEventBus();
