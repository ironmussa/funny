import { create } from 'zustand';

interface ReviewPaneState {
  /**
   * Monotonically increasing counter. Each increment signals that a
   * file-modifying tool call was detected for `dirtyThreadId`.
   */
  dirtySignal: number;
  /** The threadId that triggered the latest dirty signal. */
  dirtyThreadId: string | null;

  /** Call when a file-modifying tool call is detected for a thread. */
  notifyDirty: (threadId: string) => void;
}

export const useReviewPaneStore = create<ReviewPaneState>((set) => ({
  dirtySignal: 0,
  dirtyThreadId: null,

  notifyDirty: (threadId) =>
    set((s) => ({ dirtySignal: s.dirtySignal + 1, dirtyThreadId: threadId })),
}));
