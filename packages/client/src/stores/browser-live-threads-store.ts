import { create } from 'zustand';

import { browserSessionsApi } from '@/lib/api/browser-sessions';
import { createClientLogger } from '@/lib/client-logger';

import { omitThread } from './by-thread';

const log = createClientLogger('browser-session');

interface BrowserLiveThreadsState {
  /** Threads with a live runner browser session, keyed by thread id. */
  byThread: Record<string, true>;
  markOpen: (threadId: string) => void;
  markClosed: (threadId: string) => void;
  /** Replace every mark with the runner's list (on connect). */
  replaceAll: (threadIds: readonly string[]) => void;
}

/**
 * Which threads have a browser session open on the runner. Seeded from the
 * runner on every connect (`loadLiveBrowserThreads`), then kept current by
 * the user-scoped `browser-session:*` events (`ready` / `agent-opened` add,
 * `closed` removes).
 */
export const useBrowserLiveThreadsStore = create<BrowserLiveThreadsState>((set) => ({
  byThread: {},
  markOpen: (threadId) =>
    set((s) => (s.byThread[threadId] ? s : { byThread: { ...s.byThread, [threadId]: true } })),
  markClosed: (threadId) =>
    set((s) => {
      const byThread = omitThread(s.byThread, threadId);
      return byThread === s.byThread ? s : { byThread };
    }),
  replaceAll: (threadIds) =>
    set({ byThread: Object.fromEntries(threadIds.map((id) => [id, true as const])) }),
}));

/**
 * Ask the runner which threads hold a live browser. Realtime events are not
 * replayed after a reload or a reconnect, so without this the sidebar shows
 * no browser marks until each session happens to emit again.
 */
export async function loadLiveBrowserThreads(): Promise<void> {
  const result = await browserSessionsApi.liveThreads();
  if (result.isErr()) {
    log.warn('could not load threads with a live browser', { error: result.error.message });
    return;
  }
  useBrowserLiveThreadsStore.getState().replaceAll(result.value.threadIds);
}

export function useThreadHasLiveBrowser(threadId: string): boolean {
  return useBrowserLiveThreadsStore((s) => !!s.byThread[threadId]);
}
