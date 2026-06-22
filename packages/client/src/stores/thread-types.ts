/**
 * Pure type definitions for the thread store.
 *
 * Lives in its own file so peers (`thread-store-internals`, `thread-ws-handlers`,
 * `lib/context-usage-storage`) can reference these shapes without importing
 * `thread-store.ts` — which would create a runtime import cycle.
 *
 * Only types belong here. No values, no side effects.
 *
 * `ThreadState` (the full Zustand state + action surface) lives in
 * `./thread-state.ts` — also extracted to keep this file free of edges
 * back to `thread-store.ts`.
 */

import type { Thread, Message, ThreadEvent, WaitingReason } from '@funny/shared';

import type { ContextUsage } from '@/lib/context-usage-types';
import type { GitProgressStep } from '@/lib/git-progress-types';

export type { ContextUsage };

export interface AgentInitInfo {
  tools: string[];
  cwd: string;
  model: string;
  // SDK-reported slash commands for this session (names without leading slash).
  // Feeds the prompt editor's slash-command autocomplete.
  slashCommands?: string[];
}

export interface AgentResultInfo {
  status: 'completed' | 'failed';
  cost: number;
  duration: number;
  error?: string;
}

export interface CompactionEvent {
  trigger: 'manual' | 'auto';
  preTokens: number;
  postTokens?: number;
  timestamp: string;
}

export interface ThreadWithMessages extends Thread {
  messages: (Message & { toolCalls?: any[] })[];
  threadEvents?: ThreadEvent[];
  initInfo?: AgentInitInfo;
  resultInfo?: AgentResultInfo;
  waitingReason?: WaitingReason;
  pendingPermission?: { toolName: string; toolInput?: string };
  hasMore?: boolean;
  hasMoreAfter?: boolean;
  loadingMore?: boolean;
  /** Full message count for the thread; paired with windowStart for pagination metadata. */
  totalMessages?: number;
  /** Number of messages before the loaded window. */
  windowStart?: number;
  contextUsage?: ContextUsage;
  compactionEvents?: CompactionEvent[];
  setupProgress?: GitProgressStep[];
  lastUserMessage?: Message & { toolCalls?: any[] };
  leadingUserMessage?: Message & { toolCalls?: any[] };
  queuedCount?: number;
  queuedNextMessage?: string;
}
