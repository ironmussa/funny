/**
 * Message pagination for the thread store: loading older / newer pages of the
 * active thread and paging back until a given message is loaded.
 */
import { sleep as effectSleep } from '@funny/shared/async';

import { api } from '@/lib/api';
import { THREAD_MESSAGE_PAGE_SIZE } from '@/lib/thread-message-page';

import * as mutations from './thread-mutations';
import type { ThreadState } from './thread-state';
import { getUrlThreadId } from './thread-store-internals';
import { appendNewerMessages, prependOlderMessages } from './thread-store-messages';
import type { ThreadWithMessages } from './thread-types';
import type { Get, Set } from './thread-ws-handlers/shared';

/**
 * Imperative: resolve the active thread from the map, anchored to the URL
 * (route-driven). Falls back to `selectedThreadId` when there's no thread route
 * (e.g. tests with no router, or transient states). Reading the URL here keeps
 * WS refresh paths (`refreshActiveThread`) targeting the thread the user is
 * actually viewing even if `selectedThreadId` momentarily diverges.
 */
export function getActiveThread(state: ThreadState): ThreadWithMessages | null {
  const id = getUrlThreadId() ?? state.selectedThreadId;
  return id ? (state.threadDataById[id] ?? null) : null;
}

function setLoadingMore(set: Set, threadId: string, loadingMore: boolean): void {
  set((state) =>
    mutations.applyThreadDataPatch(state, threadId, (t) => ({
      ...t,
      loadingMore,
    })),
  );
}

/** Fetch one page older than the thread's first loaded message and prepend it.
 *  Resolves false when the thread was evicted meanwhile or the fetch failed. */
async function fetchOlderPage(
  get: Get,
  set: Set,
  threadId: string,
  before: string,
  pageSize: number,
): Promise<boolean> {
  setLoadingMore(set, threadId, true);
  const result = await api.getThreadMessages(threadId, before, pageSize);

  // Bail if user switched away. The map entry might be evicted by now.
  if (!get().threadDataById[threadId]) return false;

  if (result.isErr()) {
    setLoadingMore(set, threadId, false);
    return false;
  }

  const { messages: olderMessages, hasMore, total, leadingUserMessage } = result.value;
  set((state) =>
    mutations.applyThreadDataPatch(state, threadId, (t) => {
      const merged = prependOlderMessages(t, olderMessages, leadingUserMessage);
      return {
        ...t,
        messages: merged.messages,
        hasMore,
        hasMoreAfter: result.value.hasMoreAfter ?? t.hasMoreAfter,
        totalMessages: total ?? t.totalMessages,
        windowStart: result.value.windowStart ?? Math.max(0, (t.windowStart ?? 0) - merged.added),
        leadingUserMessage: merged.leadingUserMessage,
        loadingMore: false,
      };
    }),
  );
  return true;
}

/** One step of `loadMessagesUntil`: true / false ends the loop with that
 *  answer, null continues it. */
type UntilStep = boolean | null;

async function stepMessagesUntil(
  get: Get,
  set: Set,
  threadId: string,
  messageId: string,
  pageSize: number,
): Promise<UntilStep> {
  const entry = get().threadDataById[threadId];
  if (entry.messages.some((m) => m.id === messageId)) return true;
  if (!entry.hasMore || entry.messages.length === 0) return false;
  if (entry.loadingMore) {
    // A scroll-triggered page load is in flight — wait and re-check.
    await effectSleep(100);
    return null;
  }

  const oldestMessage = entry.messages[0];
  setLoadingMore(set, threadId, true);
  const result = await api.getThreadMessages(threadId, oldestMessage.timestamp, pageSize);

  // Bail if the thread was evicted while we were fetching.
  if (!get().threadDataById[threadId]) return false;

  if (result.isErr()) {
    setLoadingMore(set, threadId, false);
    return false;
  }

  const { messages: olderMessages, hasMore, leadingUserMessage } = result.value;
  set((state) =>
    mutations.applyThreadDataPatch(state, threadId, (t) => {
      const merged = prependOlderMessages(t, olderMessages, leadingUserMessage);
      return {
        ...t,
        messages: merged.messages,
        hasMore,
        leadingUserMessage: merged.leadingUserMessage,
        loadingMore: false,
      };
    }),
  );
  return null;
}

export function createPagingActions(
  set: Set,
  get: Get,
): Pick<ThreadState, 'loadOlderMessages' | 'loadNewerMessages' | 'loadMessagesUntil'> {
  return {
    loadOlderMessages: async () => {
      const active = getActiveThread(get());
      if (!active || !active.hasMore || active.loadingMore) return;

      const oldestMessage = active.messages[0];
      if (!oldestMessage) return;
      await fetchOlderPage(get, set, active.id, oldestMessage.timestamp, THREAD_MESSAGE_PAGE_SIZE);
    },

    loadNewerMessages: async () => {
      const active = getActiveThread(get());
      if (!active || !active.hasMoreAfter || active.loadingMore) return;

      const newestMessage = active.messages.at(-1);
      if (!newestMessage) return;
      const threadId = active.id;

      setLoadingMore(set, threadId, true);
      const result = await api.getThreadMessages(
        threadId,
        newestMessage.timestamp,
        THREAD_MESSAGE_PAGE_SIZE,
        'after',
      );

      if (!get().threadDataById[threadId]) return;

      if (result.isErr()) {
        setLoadingMore(set, threadId, false);
        return;
      }

      const { messages: newerMessages, hasMoreAfter, total } = result.value;
      set((state) =>
        mutations.applyThreadDataPatch(state, threadId, (t) => {
          const merged = appendNewerMessages(t, newerMessages);
          return {
            ...t,
            messages: merged.messages,
            lastUserMessage: merged.lastUserMessage,
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
        if (!get().threadDataById[threadId]) {
          // Evicted mid-loop → abort. Not hydrated yet (navigation just landed
          // on the thread) → wait for the initial load instead of giving up.
          if (sawEntry) return false;
          await effectSleep(150);
          continue;
        }
        sawEntry = true;
        const step = await stepMessagesUntil(get, set, threadId, messageId, PAGE_SIZE);
        if (step !== null) return step;
      }
      return get().threadDataById[threadId]?.messages.some((m) => m.id === messageId) ?? false;
    },
  };
}
