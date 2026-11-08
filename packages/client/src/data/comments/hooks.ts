import type { ThreadComment } from '@funny/shared';
import { eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';

import { useDataLayer, useDataQuery } from '../hooks';
import { liveQueryKey } from '../live-query-key';
import { commentsQuery, compareComments, getCommentsData } from './store';

/**
 * One thread's comments, oldest first, fetched every time a reader mounts.
 * `comments` is null until the first load lands.
 */
export function useThreadComments(threadId: string | null | undefined): {
  comments: ThreadComment[] | null;
  loading: boolean;
} {
  const layer = useDataLayer();
  const data = getCommentsData(layer);
  const id = threadId ?? '';
  const query = useDataQuery({ ...commentsQuery(id, layer), enabled: !!threadId });
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('comments:useThreadComments', data.collection, id),
    query: (q) =>
      q.from({ comment: data.collection }).where(({ comment }) => eq(comment.threadId, id)),
  });
  const loaded = query.data !== undefined;
  return useMemo(() => {
    if (!threadId || (!loaded && (!rows || rows.length === 0))) {
      return { comments: null, loading: query.isFetching };
    }
    const comments = (rows ?? []).map((row) => data.fromRow(row as ThreadComment));
    return { comments: comments.sort(compareComments), loading: query.isFetching };
  }, [threadId, loaded, rows, data, query.isFetching]);
}
