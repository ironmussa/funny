/**
 * Helpers shared by the thread WebSocket handlers: the store accessor types,
 * the sidebar row patch, the hydration buffer and the debounced project refresh.
 */

import type { Thread, ThreadStatus } from '@funny/shared';

import { isThreadListed, listedProjectIds } from '@/data/threads/read';
import { createClientLogger } from '@/lib/client-logger';

import { useThreadActiveToolStore } from '../thread-active-tool-store';
import { patchThreadRow } from '../thread-row-writes';
import type { ThreadState } from '../thread-state';
import { bufferWSEvent, getUrlThreadId } from '../thread-store-internals';

export const wsLog = createClientLogger('ws-handlers');

export type Get = () => ThreadState;
export type Set = (
  partial: Partial<ThreadState> | ((state: ThreadState) => Partial<ThreadState>),
) => void;
const TERMINAL_STATUSES = new Set<ThreadStatus>(['completed', 'failed', 'stopped', 'interrupted']);

/**
 * `completedAt` for a run that just ended, for the list order and the
 * "ended ago" label. `updatedAt` is left to the server: the stale-row guard
 * compares it with server rows, and the client clock may be skewed.
 */
export function terminalTimestamps(status: ThreadStatus, now = new Date().toISOString()) {
  if (!TERMINAL_STATUSES.has(status)) return {};
  return { completedAt: now };
}

export function findTailUserMessageWithContent(
  messages: NonNullable<ThreadState['activeThread']>['messages'],
  content: string,
): number {
  const tailIdx = messages.length - 1;
  if (tailIdx < 0) return -1;
  const tail = messages[tailIdx];
  return tail.role === 'user' && tail.content === content ? tailIdx : -1;
}

// ── Sidebar update helper ─────────────────────────────────────
//
// Thread rows live once, in the data layer's threads collection. Patching a
// sidebar-visible field (status, lastAssistantMessage, cost, stage, etc.) is
// a synced write via `patchThreadRow`, regardless of which list it is in.
//
// `found` tells callers whether the thread is in a loaded list, so they can
// fall back to a project refresh otherwise. A row can be held without being
// listed (a thread opened by URL); it is still patched, so the detail view
// stays live, but the refresh still runs to list it.
export function patchSidebarThread(threadId: string, updater: (thread: Thread) => Thread): boolean {
  return patchThreadRow(threadId, updater) && isThreadListed(threadId);
}

/**
 * Convenience wrapper around `patchSidebarThread` for the common case of
 * patching `lastAssistantMessage`. Slices content to 120 chars to match the
 * existing sidebar snippet truncation.
 */
export function patchSidebarLastAssistant(threadId: string, content: string): void {
  const snippet = content.slice(0, 120);
  // The agent's text replaces the tool it was running as the row's snippet.
  useThreadActiveToolStore.getState().clear(threadId);
  patchSidebarThread(threadId, (t) =>
    t.lastAssistantMessage === snippet ? t : { ...t, lastAssistantMessage: snippet },
  );
}

/** True when the thread payload is loaded in the unified map. */
export function isHydrated(state: ThreadState, threadId: string): boolean {
  return !!state.threadDataById[threadId];
}

/**
 * Buffer the event when the thread is being selected but not yet hydrated.
 * Returns true when buffering happened so callers can short-circuit.
 */
export function maybeBuffer<EventData>(
  state: ThreadState,
  threadId: string,
  type: string,
  data: EventData,
): boolean {
  if ((getUrlThreadId() ?? state.selectedThreadId) === threadId && !isHydrated(state, threadId)) {
    bufferWSEvent(threadId, type, data);
    return true;
  }
  return false;
}

// ── Debounced "refresh all projects" for unknown threads ─────────
// When a WS event arrives for a thread not in any loaded project, we need to
// refresh projects so it appears. But doing this on every event causes an
// O(projects) API storm. Debounce to at most once per 2 seconds.
let refreshAllTimer: ReturnType<typeof setTimeout> | null = null;
const pendingRefreshPids = new Set<string>();

export function scheduleProjectRefresh(get: Get, specificPid?: string): void {
  if (specificPid) {
    pendingRefreshPids.add(specificPid);
  }
  if (refreshAllTimer) return; // already scheduled
  refreshAllTimer = setTimeout(() => {
    refreshAllTimer = null;
    const { loadThreadsForProject } = get();
    if (pendingRefreshPids.size > 0) {
      for (const pid of pendingRefreshPids) {
        loadThreadsForProject(pid);
      }
    } else {
      // No specific project — refresh all loaded projects
      for (const pid of listedProjectIds()) {
        loadThreadsForProject(pid);
      }
    }
    pendingRefreshPids.clear();
  }, 2000);
}
