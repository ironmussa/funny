/**
 * Anchors that keep a thread's payload in `threadDataById`.
 *
 * A "registration" is an explicit anchor on `threadDataById[id]`. Live
 * columns register on mount so the payload stays loaded for streaming;
 * the right pane anchors implicitly via `selectedThreadId`. A thread is
 * evicted from the map only when BOTH anchors drop.
 */

import { adoptThreadDetail } from '@/data/threads/loaders';
import { api } from '@/lib/api';
import { THREAD_MESSAGE_PAGE_SIZE } from '@/lib/thread-message-page';
import { loadThreadScrollFetchOptions } from '@/lib/thread-scroll-position';

import { settlePreSendStateFromFetch } from './optimistic-run-state';
import { cleanupThreadActor } from './thread-machine-bridge';
import * as mutations from './thread-mutations';
import type { ThreadState } from './thread-state';
import type { ThreadWithMessages } from './thread-types';
import type { Get, Set } from './thread-ws-handlers/shared';

// Ref-count for explicit registrations from live columns. A thread is
// kept in `threadDataById` while EITHER it's the selected thread (implicit
// anchor) OR refcount > 0. When both drop, `evictIfUnreferenced` removes
// the payload so memory doesn't grow without bound.
const liveThreadRefCounts = new Map<string, number>();

/** Forget a thread's live-column registrations (thread gone or project cleared). */
export function dropLiveThreadRefs(threadId: string): void {
  liveThreadRefCounts.delete(threadId);
}

/**
 * Drop `threadDataById[threadId]` iff there's no remaining anchor
 * (refcount === 0 AND thread is not the currently selected one). Caller
 * is responsible for invoking after a refcount/select change.
 */
export function evictIfUnreferenced(get: Get, set: Set, threadId: string): void {
  if ((liveThreadRefCounts.get(threadId) ?? 0) > 0) return;
  const state = get();
  if (state.selectedThreadId === threadId) return;
  if (!(threadId in state.threadDataById)) return;
  const { [threadId]: _, ...rest } = state.threadDataById;
  set({ threadDataById: rest });
}

/**
 * Drop every local trace of a thread that no longer exists for this user
 * (deleted here or elsewhere, or its share was revoked): status actor,
 * live-column refcount, loaded payload and selection. The row itself is
 * removed from the threads collection by the caller.
 */
export function forgetThread(get: Get, set: Set, threadId: string): void {
  cleanupThreadActor(threadId);
  liveThreadRefCounts.delete(threadId);
  set((state) => mutations.clearThreadData(state, threadId));
  if (get().selectedThreadId === threadId) {
    set({ selectedThreadId: null, activeThread: null });
  }
}

/** `registerLiveThread` / `unregisterLiveThread`: the live-column anchors. */
export function createLiveThreadActions(
  set: Set,
  get: Get,
): Pick<ThreadState, 'registerLiveThread' | 'unregisterLiveThread'> {
  return {
    registerLiveThread: async (threadId) => {
      const prev = liveThreadRefCounts.get(threadId) ?? 0;
      liveThreadRefCounts.set(threadId, prev + 1);

      // Already hydrated (either by a previous register or because it's the
      // selected thread) — just hold the anchor.
      if (get().threadDataById[threadId]) return;
      if (prev > 0) return; // a sibling registration is racing the same fetch

      const result = await api.getThread(
        threadId,
        THREAD_MESSAGE_PAGE_SIZE,
        undefined,
        loadThreadScrollFetchOptions(threadId),
      );
      if (result.isErr()) return;

      // Refcount may have dropped while fetching (unmount, race) — only land
      // the data if someone still wants it.
      if ((liveThreadRefCounts.get(threadId) ?? 0) <= 0) return;
      settlePreSendStateFromFetch(result.value.id, result.value.status);
      adoptThreadDetail(result.value);
      set((state) => mutations.setThreadData(state, threadId, result.value as ThreadWithMessages));
    },

    unregisterLiveThread: (threadId) => {
      const count = (liveThreadRefCounts.get(threadId) ?? 1) - 1;
      if (count > 0) {
        liveThreadRefCounts.set(threadId, count);
        return;
      }
      liveThreadRefCounts.delete(threadId);
      evictIfUnreferenced(get, set, threadId);
    },
  };
}
