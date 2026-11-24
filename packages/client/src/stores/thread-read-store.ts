import {
  createThreadReadStore,
  isThreadUnread,
  type ThreadReadState,
} from '@funny/client-core/stores/thread-read';
import { create } from 'zustand';

import { bindVanillaStore } from '@/platform/bind-vanilla-store';
import { clientComposition } from '@/platform/client-composition';

const threadReadStore = createThreadReadStore({
  storage: clientComposition.platform.storage,
  diagnostics: clientComposition.platform.diagnostics,
});

export const useThreadReadStore = bindVanillaStore<ThreadReadState>(threadReadStore);
export { isThreadUnread };

/**
 * What the owner had seen of a thread when they opened it (openspec
 * `thread-recap`, D5): the read marker as it was BEFORE `selectThread` marks
 * the thread read, and the newest activity of the loaded payload. The recap
 * card reads it, so a recap covers what happened while the owner was away
 * and stays keyed to the message that was newest on open, not to every
 * message that streams in while they watch.
 */
export interface ThreadOpenSnapshot {
  /** `readAt[threadId]` before the open marked it read; null when never read. */
  readAt: string | null;
  /** When the thread was opened (ms), the `now` of the absence rule. */
  openedAt: number;
  createdAt: string | null;
  newestMessageId: string | null;
  newestActivityAt: string | null;
}

interface ThreadOpenState {
  byThread: Record<string, ThreadOpenSnapshot>;
}

export const useThreadOpenStore = create<ThreadOpenState>(() => ({ byThread: {} }));

/**
 * Record the open of a thread. Call it before the thread is marked read: the
 * read marker it captures is the one the recap's `since` comes from.
 */
export function recordThreadOpened(
  threadId: string,
  activity: Omit<ThreadOpenSnapshot, 'readAt' | 'openedAt'>,
  openedAt: number = Date.now(),
): void {
  const readAt = useThreadReadStore.getState().readAt[threadId] ?? null;
  useThreadOpenStore.setState((s) => ({
    byThread: { ...s.byThread, [threadId]: { ...activity, readAt, openedAt } },
  }));
}

/** The snapshot of the thread's latest open, if it was opened this session. */
export function useThreadOpenSnapshot(
  threadId: string | null | undefined,
): ThreadOpenSnapshot | undefined {
  return useThreadOpenStore((s) => (threadId ? s.byThread[threadId] : undefined));
}
