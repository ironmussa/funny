/**
 * Resync actions for the thread store: refetching the active thread after a
 * reconnect (recovering missed messages), refetching every loaded list, and
 * dropping a project's threads.
 */
import type { ThreadEvent } from '@funny/shared';
import type { Result } from 'neverthrow';

import {
  applyThreadDetail,
  beginThreadRequest,
  dropProjectThreads as clearProjectThreadRows,
  loadProjectThreads,
} from '@/data/threads/loaders';
import { listedProjectThreadIds, readThreadIndex } from '@/data/threads/read';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { metric } from '@/lib/telemetry';
import { THREAD_MESSAGE_PAGE_SIZE } from '@/lib/thread-message-page';
import { loadThreadScrollFetchOptions } from '@/lib/thread-scroll-position';

import { settlePreSendStateFromFetch } from './optimistic-run-state';
import * as mutations from './thread-mutations';
import type { ThreadState } from './thread-state';
import { dropLiveRef } from './thread-store-live-refs';
import { mergeMessagesById, type LocalMessage } from './thread-store-messages';
import { getActiveThread } from './thread-store-paging';
import type { CompactionEvent, ThreadWithMessages } from './thread-types';
import type { Get, Set } from './thread-ws-handlers/shared';

const refreshLog = createClientLogger('thread-refresh');

/** The thread detail `api.getThread` answers with. */
type FetchedThread =
  Awaited<ReturnType<typeof api.getThread>> extends Result<infer T, unknown> ? T : never;

/** True for a string value. */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Reconstruct compactionEvents from persisted thread events. */
function persistedCompactionEvents(threadEvents: ThreadEvent[] | undefined): CompactionEvent[] {
  return (threadEvents ?? []).flatMap((event) => {
    if (event.type !== 'compact_boundary') return [];
    const data = isString(event.data) ? JSON.parse(event.data) : event.data;
    return [
      {
        trigger: data.trigger ?? 'auto',
        preTokens: data.preTokens ?? 0,
        timestamp: data.timestamp ?? event.createdAt,
      },
    ];
  });
}

/** Merge a refetched thread into its loaded payload. */
function mergeRefreshedPayload(
  threadId: string,
  current: ThreadWithMessages,
  thread: FetchedThread,
  threadEvents: ThreadEvent[] | undefined,
  persistedCompaction: CompactionEvent[],
): ThreadWithMessages {
  // Merge messages — recovers any agent:message / agent:tool_call events that
  // were emitted by the server while the WebSocket was disconnected. The
  // server is source of truth for the recent window; older paginated
  // messages already loaded by the client are preserved.
  const freshMessages = (thread.messages ?? []) as LocalMessage[];
  const mergedMessages = mergeMessagesById(current.messages, freshMessages);
  const recovered = mergedMessages.length - current.messages.length;
  if (recovered > 0) {
    refreshLog.info('Recovered missed messages on resync', {
      threadId,
      recovered,
      local: current.messages.length,
      fresh: freshMessages.length,
      merged: mergedMessages.length,
    });
    metric('thread.resync.messages_recovered', recovered, {
      attributes: { 'thread.id': threadId },
    });
  }
  const resultInfo =
    current.resultInfo ??
    (thread.status === 'completed' || thread.status === 'failed'
      ? {
          status: thread.status as 'completed' | 'failed',
          cost: thread.cost,
          duration: 0,
          error: (thread as any).error,
        }
      : undefined);
  // Clear waitingReason/pendingPermission if server status is no longer waiting
  // (handles case where agent:result WS event was lost during disconnect)
  const isServerWaiting = thread.status === 'waiting';
  return {
    ...current,
    status: thread.status,
    cost: thread.cost,
    stage: thread.stage,
    completedAt: thread.completedAt,
    archived: thread.archived,
    pinned: thread.pinned,
    mode: thread.mode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    baseBranch: thread.baseBranch,
    initInfo: current.initInfo,
    resultInfo,
    threadEvents,
    messages: mergedMessages,
    lastUserMessage: thread.lastUserMessage ?? current.lastUserMessage,
    hasMore: thread.hasMore ?? current.hasMore,
    compactionEvents:
      persistedCompaction.length > 0 ? persistedCompaction : current.compactionEvents,
    waitingReason: isServerWaiting ? (thread.waitingReason ?? current.waitingReason) : undefined,
    pendingPermission: isServerWaiting
      ? (thread.pendingPermission ?? current.pendingPermission)
      : undefined,
  };
}

export function createRefreshActions(
  set: Set,
  get: Get,
): Pick<ThreadState, 'refreshActiveThread' | 'refreshAllLoadedThreads' | 'clearProjectThreads'> {
  return {
    refreshActiveThread: async () => {
      const active = getActiveThread(get());
      if (!active) return;
      const threadId = active.id;
      const requestSeq = beginThreadRequest();
      const [result, eventsResult] = await Promise.all([
        api.getThread(
          threadId,
          THREAD_MESSAGE_PAGE_SIZE,
          undefined,
          loadThreadScrollFetchOptions(threadId),
        ),
        api.getThreadEvents(threadId),
      ]);
      if (result.isErr()) return; // silently ignore
      const thread = result.value;
      settlePreSendStateFromFetch(threadId, thread.status);
      const eventsFallback = active.threadEvents;
      const threadEvents = eventsResult.isOk() ? eventsResult.value.events : eventsFallback;
      const persistedCompaction = persistedCompactionEvents(threadEvents);

      // Use the functional set() form so the merge base + spread base read the
      // freshest payload from the map. Without this, a WS agent:message that
      // arrives during the await above gets clobbered.
      set((state) => {
        // Sidebar row fields go to the threads collection (fenced against
        // confirmed user writes); threadsById is projected from it.
        applyThreadDetail(
          threadId,
          {
            status: thread.status,
            cost: thread.cost,
            stage: thread.stage,
            completedAt: thread.completedAt,
            updatedAt: thread.updatedAt,
            archived: thread.archived,
            pinned: thread.pinned,
            mode: thread.mode,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            baseBranch: thread.baseBranch,
          },
          requestSeq,
        );

        return {
          ...mutations.applyThreadDataPatch(state, threadId, (current) =>
            mergeRefreshedPayload(threadId, current, thread, threadEvents, persistedCompaction),
          ),
        };
      });
    },

    refreshAllLoadedThreads: async () => {
      const lists = readThreadIndex();
      const projectIds = Object.keys(lists.threadIdsByProject);
      const refreshScratch = lists.scratchThreadIds.length > 0;
      const refreshShared = lists.sharedThreadIds.length > 0;

      // Refetch every loaded project list in parallel through the data layer.
      await Promise.all(projectIds.map((pid) => loadProjectThreads(pid)));

      await Promise.all([
        refreshScratch ? get().loadScratchThreads() : Promise.resolve(),
        refreshShared ? get().loadSharedThreads() : Promise.resolve(),
      ]);
      await get().refreshActiveThread();
    },

    clearProjectThreads: (projectId: string) => {
      set((state) => {
        const ids = listedProjectThreadIds(projectId);
        clearProjectThreadRows(projectId);
        let patch: Partial<ThreadState> = {};
        if (ids && ids.length) {
          // Drop any payload entries that belonged to the cleared project. Use a
          // working state so multiple deletions compose without losing earlier
          // map mutations.
          let working: ThreadState = { ...state, ...patch } as ThreadState;
          for (const id of ids) {
            dropLiveRef(id);
            const sub = mutations.clearThreadData(working, id);
            Object.assign(patch, sub);
            working = Object.assign({ ...working }, sub) as ThreadState;
          }
        }
        const active = state.activeThread;
        const clearSelection = active?.projectId === projectId;
        if (clearSelection) {
          return { ...patch, selectedThreadId: null, activeThread: null };
        }
        return patch;
      });
    },
  };
}
