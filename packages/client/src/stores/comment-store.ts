import type { ThreadComment } from '@funny/shared';
import { create } from 'zustand';

import { threadsApi } from '@/lib/api/threads';
import { createClientLogger } from '@/lib/client-logger';

/**
 * Thread comments for the shared-thread Comments panel. Comments are a flat,
 * thread-level discussion feed (the `thread_comments` row has no message anchor)
 * shared between the thread owner and anyone the thread is shared with.
 *
 * The panel fetches on open (`fetch`) and posts/deletes through this store; live
 * `thread:comment` / `thread:comment_deleted` WS events feed `applyAdded` /
 * `applyDeleted` so every current viewer sees new comments without a refetch
 * (see hooks/ws-event-dispatch.ts). Mirrors the presence-store shape.
 */

const log = createClientLogger('comments');

interface CommentState {
  /** threadId → comments, oldest first. */
  byThread: Record<string, ThreadComment[]>;
  /** threadId → an in-flight fetch is running. */
  loadingByThread: Record<string, boolean>;
  /** Fetch (or refetch) the full comment list for a thread. */
  fetch: (threadId: string) => Promise<void>;
  /** Post a comment; the live WS event reconciles it for everyone (incl. self). */
  post: (threadId: string, content: string) => Promise<boolean>;
  /** Delete a comment (owner-only on the server). */
  remove: (threadId: string, commentId: string) => Promise<void>;
  /** Append a comment from a `thread:comment` WS event (deduped by id). */
  applyAdded: (threadId: string, comment: ThreadComment) => void;
  /** Drop a comment from a `thread:comment_deleted` WS event. */
  applyDeleted: (threadId: string, commentId: string) => void;
}

function upsert(list: ThreadComment[], comment: ThreadComment): ThreadComment[] {
  if (list.some((c) => c.id === comment.id)) return list;
  return [...list, comment].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export const useCommentStore = create<CommentState>((set, get) => ({
  byThread: {},
  loadingByThread: {},

  fetch: async (threadId) => {
    set((s) => ({ loadingByThread: { ...s.loadingByThread, [threadId]: true } }));
    const res = await threadsApi.getThreadComments(threadId);
    res.match(
      (rows) =>
        set((s) => ({
          byThread: { ...s.byThread, [threadId]: rows },
          loadingByThread: { ...s.loadingByThread, [threadId]: false },
        })),
      (err) => {
        log.warn('Failed to load comments', { threadId, error: String(err) });
        set((s) => ({ loadingByThread: { ...s.loadingByThread, [threadId]: false } }));
      },
    );
  },

  post: async (threadId, content) => {
    const trimmed = content.trim();
    if (!trimmed) return false;
    const res = await threadsApi.createThreadComment(threadId, trimmed);
    return res.match(
      (comment) => {
        // Reconcile immediately for the author; the WS event is a no-op dedupe.
        get().applyAdded(threadId, comment);
        return true;
      },
      (err) => {
        log.warn('Failed to post comment', { threadId, error: String(err) });
        return false;
      },
    );
  },

  remove: async (threadId, commentId) => {
    const res = await threadsApi.deleteThreadComment(threadId, commentId);
    res.match(
      () => get().applyDeleted(threadId, commentId),
      (err) => log.warn('Failed to delete comment', { threadId, commentId, error: String(err) }),
    );
  },

  applyAdded: (threadId, comment) =>
    set((s) => ({
      byThread: { ...s.byThread, [threadId]: upsert(s.byThread[threadId] ?? [], comment) },
    })),

  applyDeleted: (threadId, commentId) =>
    set((s) => {
      const current = s.byThread[threadId];
      if (!current) return s;
      return {
        byThread: { ...s.byThread, [threadId]: current.filter((c) => c.id !== commentId) },
      };
    }),
}));
