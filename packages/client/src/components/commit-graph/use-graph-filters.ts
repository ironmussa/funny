import { useCallback, useRef, useState } from 'react';

import type { CommitSyncFilter } from '@/lib/git-history-search';

/**
 * The graph's list filters: search query, sync filter and authors, each with a
 * synchronous ref mirror so the background pager reads the current value
 * instead of a stale closure.
 */
export function useGraphFilters() {
  // Search bar (always visible): a list FILTER over the loaded commits, matching
  // the commit's subject, body, or any branch/tag ref it carries (see
  // commitMatchesQuery).
  const [searchQuery, setSearchQuery] = useState('');
  const searchQueryRef = useRef('');
  const [syncFilter, setSyncFilter] = useState<CommitSyncFilter>('all');
  const syncFilterRef = useRef<CommitSyncFilter>('all');
  const [authors, setAuthors] = useState<string[]>([]);
  const [authorOptionsOpen, setAuthorOptionsOpen] = useState(false);
  const authorOptionsOpenRef = useRef(false);
  const authorsRef = useRef<string[]>([]);
  const updateAuthors = useCallback((next: string[]) => {
    authorsRef.current = next;
    setAuthors(next);
  }, []);
  const updateAuthorOptionsOpen = useCallback((open: boolean) => {
    authorOptionsOpenRef.current = open;
    setAuthorOptionsOpen(open);
  }, []);
  const setSearchQueryNow = useCallback((next: string) => {
    searchQueryRef.current = next;
    setSearchQuery(next);
  }, []);
  const toggleSyncFilter = useCallback((filter: Exclude<CommitSyncFilter, 'all'>) => {
    const next = syncFilterRef.current === filter ? 'all' : filter;
    syncFilterRef.current = next;
    setSyncFilter(next);
  }, []);
  /** True while any filter (or the author picker) wants more history paged in. */
  const wantsFilteredHistory = useCallback(
    () =>
      searchQueryRef.current.trim().length > 0 ||
      syncFilterRef.current !== 'all' ||
      authorsRef.current.length > 0 ||
      authorOptionsOpenRef.current,
    [],
  );
  /** Drop the query, sync filter and authors; they belong to the old context. */
  const resetFilters = useCallback(() => {
    searchQueryRef.current = '';
    setSearchQuery('');
    syncFilterRef.current = 'all';
    setSyncFilter('all');
    authorsRef.current = [];
    setAuthors([]);
  }, []);

  return {
    searchQuery,
    setSearchQuery: setSearchQueryNow,
    syncFilter,
    toggleSyncFilter,
    authors,
    updateAuthors,
    authorOptionsOpen,
    updateAuthorOptionsOpen,
    wantsFilteredHistory,
    resetFilters,
  };
}

export type GraphFilters = ReturnType<typeof useGraphFilters>;
