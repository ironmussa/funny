import { create } from 'zustand';

interface BrowserLiveThreadsState {
  /** Threads with a live runner browser session, keyed by thread id. */
  byThread: Record<string, true>;
  markOpen: (threadId: string) => void;
  markClosed: (threadId: string) => void;
}

/**
 * Which threads have a browser session open on the runner, learned from the
 * user-scoped `browser-session:*` events (`ready` / `agent-opened` add,
 * `closed` removes). In memory only: after a reload a thread shows up again
 * once its session emits an event (e.g. when the panel re-attaches).
 */
export const useBrowserLiveThreadsStore = create<BrowserLiveThreadsState>((set) => ({
  byThread: {},
  markOpen: (threadId) =>
    set((s) => (s.byThread[threadId] ? s : { byThread: { ...s.byThread, [threadId]: true } })),
  markClosed: (threadId) =>
    set((s) => {
      if (!s.byThread[threadId]) return s;
      const { [threadId]: _removed, ...rest } = s.byThread;
      return { byThread: rest };
    }),
}));

export function useThreadHasLiveBrowser(threadId: string): boolean {
  return useBrowserLiveThreadsStore((s) => !!s.byThread[threadId]);
}
