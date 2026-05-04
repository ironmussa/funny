/**
 * Thread read-state store — tracks which finished threads the user has seen.
 *
 * A thread is "unread" when its `completedAt` is newer than the last recorded
 * read timestamp for that thread (or no read timestamp exists). Persisted to
 * localStorage so reads survive reloads.
 */
import { create } from 'zustand';

const STORAGE_KEY = 'funny:thread-read-at';

function loadReadAt(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveReadAt(readAt: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(readAt));
  } catch {
    // ignore quota errors
  }
}

interface ThreadReadState {
  readAt: Record<string, string>;
  markRead: (threadId: string, completedAt?: string | null) => void;
}

export const useThreadReadStore = create<ThreadReadState>((set, get) => ({
  readAt: loadReadAt(),
  markRead: (threadId, completedAt) => {
    const stamp = completedAt ?? new Date().toISOString();
    const current = get().readAt[threadId];
    if (current && current >= stamp) return;
    const next = { ...get().readAt, [threadId]: stamp };
    set({ readAt: next });
    saveReadAt(next);
  },
}));

export function isThreadUnread(
  readAt: Record<string, string>,
  threadId: string,
  completedAt?: string | null,
): boolean {
  if (!completedAt) return false;
  const last = readAt[threadId];
  if (!last) return true;
  return last < completedAt;
}
