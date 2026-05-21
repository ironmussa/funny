/**
 * Thread navigation history — tracks the sequence of threads the user has
 * visited so Alt+Left / Alt+Right can walk through them (à la VSCode's
 * "Go Back" / "Go Forward").
 *
 * Shape: `past` holds visited entries in order; the last element is the
 * currently active thread. `future` holds entries that were popped off
 * `past` by a back navigation, ready to be restored by a forward navigation.
 * A normal user navigation (route change that doesn't match the last entry
 * in `past`) pushes onto `past` and clears `future`.
 */
import { create } from 'zustand';

import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('thread-history-store');

const MAX_HISTORY = 50;

export interface ThreadHistoryEntry {
  threadId: string;
  projectId: string;
  isScratch?: boolean;
}

interface ThreadHistoryState {
  past: ThreadHistoryEntry[];
  future: ThreadHistoryEntry[];
  pushThread: (entry: ThreadHistoryEntry) => void;
  goBack: () => ThreadHistoryEntry | null;
  goForward: () => ThreadHistoryEntry | null;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  clear: () => void;
}

export const useThreadHistoryStore = create<ThreadHistoryState>((set, get) => ({
  past: [],
  future: [],

  pushThread: (entry) => {
    const { past } = get();
    const last = past[past.length - 1];
    if (last && last.threadId === entry.threadId) return;
    const next = [...past, entry];
    if (next.length > MAX_HISTORY) next.splice(0, next.length - MAX_HISTORY);
    set({ past: next, future: [] });
  },

  goBack: () => {
    const { past, future } = get();
    if (past.length < 2) return null;
    const current = past[past.length - 1];
    const prev = past[past.length - 2];
    const nextFuture = [current, ...future];
    if (nextFuture.length > MAX_HISTORY) nextFuture.length = MAX_HISTORY;
    set({ past: past.slice(0, -1), future: nextFuture });
    log.debug('go back', { to: prev.threadId });
    return prev;
  },

  goForward: () => {
    const { past, future } = get();
    if (future.length === 0) return null;
    const [next, ...rest] = future;
    set({ past: [...past, next], future: rest });
    log.debug('go forward', { to: next.threadId });
    return next;
  },

  canGoBack: () => get().past.length >= 2,
  canGoForward: () => get().future.length > 0,

  clear: () => set({ past: [], future: [] }),
}));
