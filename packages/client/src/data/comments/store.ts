import type { ThreadComment } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { errAsync, okAsync, type ResultAsync } from 'neverthrow';

import { threadsApi } from '@/lib/api/threads';
import { createClientLogger } from '@/lib/client-logger';

import type { DataLayer } from '../data-layer';
import { createEntityStore, type EntityStore } from '../entities';
import { optimisticWrite } from '../optimistic-write';
import { unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';

/**
 * Thread comments for the shared-thread Comments panel: a flat, thread-level
 * discussion feed shared between the owner and the thread's sharees. One
 * collection for every thread, loaded per thread (`replaceWhere`) and kept
 * live by the `thread:comment` / `thread:comment_deleted` events.
 */

const log = createClientLogger('comments');

export function getCommentsData(layer: DataLayer = getDataLayer()): EntityStore<ThreadComment> {
  return layer.own('comments', () => {
    const data = createEntityStore<ThreadComment>(layer, 'comments');
    return {
      value: data,
      dispose: () => void data.collection.cleanup({ dependents: true }).catch(() => undefined),
    };
  });
}

/** Oldest first. */
export function compareComments(a: ThreadComment, b: ThreadComment): number {
  return a.createdAt.localeCompare(b.createdAt);
}

/** Query for one thread's comments; its result is written into the collection. */
export function commentsQuery(threadId: string, layer: DataLayer = getDataLayer()) {
  return {
    queryKey: ['comments', threadId] as const,
    staleTime: 0,
    queryFn: async (): Promise<number> => {
      const rows = await unwrapResult(threadsApi.getThreadComments(threadId)).catch(
        (error: Error) => {
          log.warn('failed to load comments', { threadId, error: error.message });
          throw error;
        },
      );
      getCommentsData(layer).replaceWhere((c) => c.threadId === threadId, rows);
      return rows.length;
    },
  };
}

/** Post a comment. `null` for blank content. The author sees it at once; the event dedupes. */
export function postComment(
  threadId: string,
  content: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<ThreadComment | null, DomainError> {
  const trimmed = content.trim();
  if (!trimmed) return okAsync(null);
  return threadsApi
    .createThreadComment(threadId, trimmed)
    .map((comment) => {
      getCommentsData(layer).upsert([comment]);
      return comment;
    })
    .mapErr((error) => {
      log.warn('failed to post comment', { threadId, error: error.message });
      return error;
    });
}

/** Delete a comment (owner-only on the server); optimistic, rolled back with a toast. */
export function deleteComment(
  threadId: string,
  commentId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<unknown, DomainError> {
  const data = getCommentsData(layer);
  if (!data.collection.has(commentId)) {
    return errAsync({ type: 'NOT_FOUND', message: `Comment ${commentId} is not loaded` });
  }
  return optimisticWrite({
    entity: 'comments',
    operation: 'delete',
    apply: () => data.collection.delete(commentId),
    persist: () => threadsApi.deleteThreadComment(threadId, commentId),
    confirm: () => data.remove([commentId]),
    failureMessageKey: 'errors.commentDeleteFailed',
  });
}

/** `thread:comment` event (deduped by id). */
export function applyCommentAdded(comment: ThreadComment, layer: DataLayer = getDataLayer()): void {
  getCommentsData(layer).upsert([comment]);
}

/** `thread:comment_deleted` event. */
export function applyCommentDeleted(commentId: string, layer: DataLayer = getDataLayer()): void {
  getCommentsData(layer).remove([commentId]);
}
