/**
 * Pure type definitions for the thread store.
 *
 * Lives in its own file so peers (`thread-store-internals`, `thread-ws-handlers`,
 * `lib/context-usage-storage`) can reference these shapes without importing
 * `thread-store.ts` — which would create a runtime import cycle.
 *
 * Only types belong here. No values, no side effects.
 *
 * `ThreadState` itself lives in `thread-store.ts` (it grew to include the full
 * action surface); re-exported from here so existing `import type { ThreadState }
 * from './thread-types'` paths keep working without churn.
 */

import type { Thread, Message, ThreadEvent, WaitingReason } from '@funny/shared';

import type { ContextUsage } from '@/lib/context-usage-types';
import type { GitProgressStep } from '@/lib/git-progress-types';

export type { ContextUsage };
export type { ThreadState } from './thread-store';

export interface AgentInitInfo {
  tools: string[];
  cwd: string;
  model: string;
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
  loadingMore?: boolean;
  contextUsage?: ContextUsage;
  compactionEvents?: CompactionEvent[];
  setupProgress?: GitProgressStep[];
  lastUserMessage?: Message & { toolCalls?: any[] };
  queuedCount?: number;
  queuedNextMessage?: string;
}
