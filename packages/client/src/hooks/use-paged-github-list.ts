import type { ResultAsync } from 'neverthrow';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAdjustOnChange } from '@/hooks/use-resettable-state';

export interface GitHubListPage<T> {
  items: T[];
  hasMore: boolean;
  owner: string;
  repo: string;
  /** Cursor-paged lists (GraphQL) return the cursor of the next page. */
  nextCursor?: string | null;
}

export type FetchGitHubListPage<T> = (
  page: number,
  signal: AbortSignal,
  /** The previous page's `nextCursor`; `undefined` for page 1. */
  cursor?: string,
) => ResultAsync<GitHubListPage<T>, { message: string }>;

/**
 * Paginated GitHub list (PRs, issues) for the right-pane tabs.
 *
 * `fetchPage` is the query: a new identity resets the list and refetches page 1,
 * so callers memoize it on their filters. `null` means there is nothing to load.
 * A list that pages by cursor returns `nextCursor`, and "load more" passes it
 * back; page-numbered lists ignore it.
 * Starting a request aborts the previous one, and hiding the tab or unmounting
 * aborts whatever is still in flight, so stale pages never land.
 *
 * Showing the tab again keeps the rows it already has while page 1 reloads
 * (stale-while-revalidate), so returning to the tab is instant. Rows are only
 * cleared when the query itself changes (other project or filter).
 */
export function usePagedGitHubList<T>({
  visible,
  fetchPage,
  errorFallback,
}: {
  visible: boolean | undefined;
  fetchPage: FetchGitHubListPage<T> | null;
  errorFallback: string;
}) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(() => !!(visible && fetchPage));
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [repoInfo, setRepoInfo] = useState<{ owner: string; repo: string } | null>(null);
  /** The query the current rows came from. */
  const [itemsQuery, setItemsQuery] = useState<{ fetchPage: FetchGitHubListPage<T> | null }>({
    fetchPage: null,
  });

  const nextCursor = useRef<string | undefined>(undefined);
  const pendingRequest = useRef<AbortController | null>(null);
  useEffect(() => () => pendingRequest.current?.abort(), [visible]);

  /** The state a request shows while it runs. */
  const beginLoad = (pageNum: number) => {
    setPage(pageNum);
    setLoading(true);
    setError(null);
  };

  /** Runs one request; every state write waits for its answer. */
  const fetchInto = useCallback(
    async (pageNum: number, append: boolean) => {
      if (!fetchPage) return;
      pendingRequest.current?.abort();
      const controller = new AbortController();
      pendingRequest.current = controller;

      const cursor = append ? nextCursor.current : undefined;
      const result = await fetchPage(pageNum, controller.signal, cursor);
      if (controller.signal.aborted) return;
      if (result.isOk()) {
        const data = result.value;
        nextCursor.current = data.nextCursor ?? undefined;
        setItemsQuery({ fetchPage });
        setItems((prev) => (append ? [...prev, ...data.items] : data.items));
        setHasMore(data.hasMore);
        setRepoInfo({ owner: data.owner, repo: data.repo });
      } else {
        setError(result.error.message || errorFallback);
      }
      setLoading(false);
    },
    [fetchPage, errorFallback],
  );

  const load = (pageNum: number, append: boolean) => {
    if (!fetchPage) return;
    beginLoad(pageNum);
    void fetchInto(pageNum, append);
  };

  // Showing the tab or changing the query reloads page 1. The state it shows
  // while loading is set during render (react.dev "adjusting state when a prop
  // changes"); the effect below only sends the request.
  useAdjustOnChange([visible, fetchPage, errorFallback], () => {
    if (visible && fetchPage) {
      if (itemsQuery.fetchPage !== fetchPage) {
        setItemsQuery({ fetchPage: null });
        setItems([]);
        setHasMore(false);
      }
      beginLoad(1);
    }
  });

  useEffect(() => {
    if (!visible || !fetchPage) return;
    void fetchInto(1, false);
  }, [visible, fetchPage, fetchInto]);

  return {
    items,
    loading,
    error,
    hasMore,
    repoInfo,
    loadMore: () => load(page + 1, true),
    refresh: () => load(1, false),
  };
}
