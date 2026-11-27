/**
 * Shared thread-snapshot hydration and WebSocket buffer replay.
 *
 * Used by both `selectThread` (main single-thread view) and
 * `registerLiveThread` (live-columns grid) so every surface renders identical
 * `threadEvents` (turn outcomes, sandbox/git events, session summaries),
 * `resultInfo`, `waitingReason`, `pendingPermission`, and `compactionEvents`.
 */
import type { ThreadEvent, ThreadWithMessages as SharedThreadWithMessages } from '@funny/shared';

import { restoreAgentAccounts } from '@/data/agent-account/store';
import { restoreContextUsage } from '@/data/context-usage/store';
import { loadAgentAccounts } from '@/lib/agent-account-storage';
import { loadContextUsage } from '@/lib/context-usage-storage';

import {
  deriveResultInfo,
  deriveWaitingState,
  reconstructCompactionEvents,
} from './thread-select-helpers';
import type { ThreadState } from './thread-state';
import { getAndClearWSBuffer, getBufferedInitInfo } from './thread-store-internals';
import type { ThreadWithMessages } from './thread-types';
import type { Get } from './thread-ws-handlers/shared';

type SnapshotThread = Omit<SharedThreadWithMessages, 'queuedCount' | 'queuedNextMessage'>;

/** The message window a fetched snapshot covers. */
function snapshotWindow(
  thread: SnapshotThread,
): Pick<ThreadWithMessages, 'hasMore' | 'hasMoreAfter' | 'totalMessages' | 'windowStart'> {
  return {
    hasMore: thread.hasMore ?? false,
    hasMoreAfter: thread.hasMoreAfter ?? false,
    totalMessages: thread.total ?? thread.messages?.length ?? 0,
    windowStart: thread.windowStart ?? 0,
  };
}

/** Build the loaded payload from a fetched snapshot, restoring the per-thread
 *  state kept outside it (context usage, agent accounts). */
export function hydrateThreadSnapshot(
  get: Get,
  threadId: string,
  thread: SnapshotThread,
  threadEvents: ThreadEvent[],
): ThreadWithMessages {
  const buffered = getBufferedInitInfo(threadId);
  const resultInfo = deriveResultInfo(thread);

  // Derive waitingReason and pendingPermission from the last tool call when reloading a waiting thread
  const { waitingReason, pendingPermission } = deriveWaitingState(thread);

  // Reconstruct compactionEvents from persisted thread events so they survive refreshes
  const compactionEvents = reconstructCompactionEvents(threadEvents);

  // Merge stored setup progress for setting_up threads
  const storedSetupProgress =
    thread.status === 'setting_up' ? get().setupProgressByThread[threadId] : undefined;

  // Restore context usage from localStorage when this session has none yet
  // (e.g. fresh tab), so the ring re-appears before the next WS event fires.
  restoreContextUsage(threadId, () => loadContextUsage(threadId));
  restoreAgentAccounts(loadAgentAccounts);

  return {
    ...thread,
    ...snapshotWindow(thread),
    leadingUserMessage: thread.leadingUserMessage,
    threadEvents,
    initInfo: thread.initInfo || buffered || undefined,
    resultInfo,
    waitingReason,
    pendingPermission,
    setupProgress: storedSetupProgress,
    compactionEvents: compactionEvents.length > 0 ? compactionEvents : undefined,
  };
}

/** Replay WebSocket events that arrived while a thread's snapshot was loading. */
export function flushWSBuffer(threadId: string, store: ThreadState): void {
  const events = getAndClearWSBuffer(threadId);
  if (!events) return;
  for (const event of events) {
    switch (event.type) {
      case 'message':
        store.handleWSMessage(threadId, event.data);
        break;
      case 'tool_call':
        store.handleWSToolCall(threadId, event.data);
        break;
      case 'tool_output':
        store.handleWSToolOutput(threadId, event.data);
        break;
      case 'status':
        store.handleWSStatus(threadId, event.data);
        break;
      case 'error':
        store.handleWSError(threadId, event.data);
        break;
      case 'result':
        store.handleWSResult(threadId, event.data);
        break;
      case 'compact_boundary':
        store.handleWSCompactBoundary(threadId, event.data);
        break;
    }
  }
}
