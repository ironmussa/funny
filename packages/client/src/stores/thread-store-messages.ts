/**
 * The open thread's message window: paging older / newer messages in, and
 * the resync that recovers what the WebSocket missed.
 */

import { sleep as effectSleep } from '@funny/shared/async';

import { applyThreadDetail, beginThreadRequest } from '@/data/threads/loaders';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { metric } from '@/lib/telemetry';
import { THREAD_MESSAGE_PAGE_SIZE } from '@/lib/thread-message-page';
import { loadThreadScrollFetchOptions } from '@/lib/thread-scroll-position';

import { settlePreSendStateFromFetch } from './optimistic-run-state';
import {
  isLocalEchoUserMessage,
  mergeMessagesById,
  userMessageDedupKey,
  type LocalMessage,
} from './thread-message-merge';
import * as mutations from './thread-mutations';
import type { ThreadState } from './thread-state';
import { getUrlThreadId } from './thread-store-internals';
import type { CompactionEvent, ThreadWithMessages } from './thread-types';
import type { Get, Set } from './thread-ws-handlers/shared';

const refreshLog = createClientLogger('thread-refresh');

/**
 * Imperative: resolve the active thread from the map, anchored to the URL
 * (route-driven). Falls back to `selectedThreadId` when there's no thread route
 * (e.g. tests with no router, or transient states). Reading the URL here keeps
 * WS refresh paths (`refreshActiveThread`) targeting the thread the user is
 * actually viewing even if `selectedThreadId` momentarily diverges.
 */
function getActiveThread(state: ThreadState): ThreadWithMessages | null {
  const id = getUrlThreadId() ?? state.selectedThreadId;
  return id ? (state.threadDataById[id] ?? null) : null;
}

type MessagePageKeys = 'loadOlderMessages' | 'loadNewerMessages' | 'loadMessagesUntil';

/** Paging the loaded message window backwards and forwards. */
export function createMessagePageActions(set: Set, get: Get): Pick<ThreadState, MessagePageKeys> {
  return {
    loadOlderMessages: async () => {
      const active = getActiveThread(get());
      if (!active || !active.hasMore || active.loadingMore) return;

      const oldestMessage = active.messages[0];
      if (!oldestMessage) return;
      const threadId = active.id;

      set((state) =>
        mutations.applyThreadDataPatch(state, threadId, (t) => ({
          ...t,
          loadingMore: true,
        })),
      );

      const result = await api.getThreadMessages(
        threadId,
        oldestMessage.timestamp,
        THREAD_MESSAGE_PAGE_SIZE,
      );

      // Bail if user switched away. The map entry might be evicted by now.
      const current = get().threadDataById[threadId];
      if (!current) return;

      if (result.isErr()) {
        set((state) =>
          mutations.applyThreadDataPatch(state, threadId, (t) => ({
            ...t,
            loadingMore: false,
          })),
        );
        return;
      }

      const { messages: olderMessages, hasMore, total, leadingUserMessage } = result.value;
      set((state) =>
        mutations.applyThreadDataPatch(state, threadId, (t) => {
          // Deduplicate in case of overlapping timestamps
          const existingIds = new Set(t.messages.map((m) => m.id));
          const newMessages = olderMessages.filter((m) => !existingIds.has(m.id));
          const nextMessages = [...newMessages, ...t.messages];
          const leadingUserAlreadyLoaded =
            leadingUserMessage != null && nextMessages.some((m) => m.id === leadingUserMessage.id);
          return {
            ...t,
            messages: nextMessages,
            hasMore,
            hasMoreAfter: result.value.hasMoreAfter ?? t.hasMoreAfter,
            totalMessages: total ?? t.totalMessages,
            windowStart:
              result.value.windowStart ?? Math.max(0, (t.windowStart ?? 0) - newMessages.length),
            leadingUserMessage: leadingUserAlreadyLoaded ? undefined : leadingUserMessage,
            loadingMore: false,
          };
        }),
      );
    },

    loadNewerMessages: async () => {
      const active = getActiveThread(get());
      if (!active || !active.hasMoreAfter || active.loadingMore) return;

      const newestMessage = active.messages.at(-1);
      if (!newestMessage) return;
      const threadId = active.id;

      set((state) =>
        mutations.applyThreadDataPatch(state, threadId, (t) => ({
          ...t,
          loadingMore: true,
        })),
      );

      const result = await api.getThreadMessages(
        threadId,
        newestMessage.timestamp,
        THREAD_MESSAGE_PAGE_SIZE,
        'after',
      );

      const current = get().threadDataById[threadId];
      if (!current) return;

      if (result.isErr()) {
        set((state) =>
          mutations.applyThreadDataPatch(state, threadId, (t) => ({
            ...t,
            loadingMore: false,
          })),
        );
        return;
      }

      const { messages: newerMessages, hasMoreAfter, total } = result.value;
      set((state) =>
        mutations.applyThreadDataPatch(state, threadId, (t) => {
          const existingIds = new Set(t.messages.map((m) => m.id));
          // A just-sent follow-up lives locally as an optimistic bubble whose
          // random id never matches the persisted row, and the persisted copy is
          // always newer than the bubble's timestamp — so it lands in this
          // 'after' page. Reconcile it onto the bubble (adopting the server id)
          // instead of appending a second identical user card.
          let baseMessages = t.messages;
          let lastUserMessage = t.lastUserMessage;
          const appended: typeof newerMessages = [];
          for (const m of newerMessages) {
            if (existingIds.has(m.id)) continue;
            const echoIdx =
              m.role === 'user'
                ? baseMessages.findIndex(
                    (lm) =>
                      isLocalEchoUserMessage(lm) &&
                      userMessageDedupKey(lm) === userMessageDedupKey(m),
                  )
                : -1;
            if (echoIdx >= 0) {
              const reconciled = { ...baseMessages[echoIdx], ...m };
              const echoId = baseMessages[echoIdx].id;
              baseMessages = baseMessages.map((lm, i) => (i === echoIdx ? reconciled : lm));
              if (lastUserMessage?.id === echoId) lastUserMessage = reconciled;
              continue;
            }
            appended.push(m);
          }
          return {
            ...t,
            messages: [...baseMessages, ...appended],
            lastUserMessage,
            hasMore: result.value.hasMore ?? t.hasMore,
            hasMoreAfter: hasMoreAfter ?? false,
            totalMessages: total ?? t.totalMessages,
            windowStart: result.value.windowStart ?? t.windowStart,
            loadingMore: false,
          };
        }),
      );
    },

    loadMessagesUntil: async (threadId, messageId) => {
      // Safety valve: bounded pages per navigation. Already-loaded pages stay
      // in the store, so a retry continues from where this attempt stopped.
      const MAX_PAGES = 40;
      const PAGE_SIZE = 100;
      let sawEntry = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const entry = get().threadDataById[threadId];
        if (!entry) {
          // Evicted mid-loop → abort. Not hydrated yet (navigation just landed
          // on the thread) → wait for the initial load instead of giving up.
          if (sawEntry) return false;
          await effectSleep(150);
          continue;
        }
        sawEntry = true;
        if (entry.messages.some((m) => m.id === messageId)) return true;
        if (!entry.hasMore || entry.messages.length === 0) return false;
        if (entry.loadingMore) {
          // A scroll-triggered page load is in flight — wait and re-check.
          await effectSleep(100);
          continue;
        }

        const oldestMessage = entry.messages[0];
        set((state) =>
          mutations.applyThreadDataPatch(state, threadId, (t) => ({
            ...t,
            loadingMore: true,
          })),
        );

        const result = await api.getThreadMessages(threadId, oldestMessage.timestamp, PAGE_SIZE);

        // Bail if the thread was evicted while we were fetching.
        if (!get().threadDataById[threadId]) return false;

        if (result.isErr()) {
          set((state) =>
            mutations.applyThreadDataPatch(state, threadId, (t) => ({
              ...t,
              loadingMore: false,
            })),
          );
          return false;
        }

        const { messages: olderMessages, hasMore, leadingUserMessage } = result.value;
        set((state) =>
          mutations.applyThreadDataPatch(state, threadId, (t) => {
            const existingIds = new Set(t.messages.map((m) => m.id));
            const newMessages = olderMessages.filter((m) => !existingIds.has(m.id));
            const nextMessages = [...newMessages, ...t.messages];
            const leadingUserAlreadyLoaded =
              leadingUserMessage != null &&
              nextMessages.some((m) => m.id === leadingUserMessage.id);
            return {
              ...t,
              messages: nextMessages,
              hasMore,
              leadingUserMessage: leadingUserAlreadyLoaded ? undefined : leadingUserMessage,
              loadingMore: false,
            };
          }),
        );
      }
      return get().threadDataById[threadId]?.messages.some((m) => m.id === messageId) ?? false;
    },
  };
}

/** The `refreshActiveThread` store action. */
export async function refreshActiveThreadFlow(set: Set, get: Get): Promise<void> {
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

  // Reconstruct compactionEvents from persisted thread events
  const persistedCompaction: CompactionEvent[] = (threadEvents ?? []).flatMap((event) => {
    if (event.type !== 'compact_boundary') return [];
    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    return [
      {
        trigger: data.trigger ?? 'auto',
        preTokens: data.preTokens ?? 0,
        timestamp: data.timestamp ?? event.createdAt,
      },
    ];
  });
  // Clear waitingReason/pendingPermission if server status is no longer waiting
  // (handles case where agent:result WS event was lost during disconnect)
  const isServerWaiting = thread.status === 'waiting';

  // Merge messages — recovers any agent:message / agent:tool_call events that
  // were emitted by the server while the WebSocket was disconnected. The
  // server is source of truth for the recent window; older paginated
  // messages already loaded by the client are preserved.
  //
  // Use the functional set() form so the merge base + spread base read the
  // freshest payload from the map. Without this, a WS agent:message that
  // arrives during the await above gets clobbered.
  const freshMessages = (thread.messages ?? []) as LocalMessage[];
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
      ...mutations.applyThreadDataPatch(state, threadId, (current) => {
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
          waitingReason: isServerWaiting
            ? (thread.waitingReason ?? current.waitingReason)
            : undefined,
          pendingPermission: isServerWaiting
            ? (thread.pendingPermission ?? current.pendingPermission)
            : undefined,
        };
      }),
    };
  });
}
