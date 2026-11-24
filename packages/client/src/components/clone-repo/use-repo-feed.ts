import type { GitHubRepo } from '@funny/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useResettableState } from '@/hooks/use-resettable-state';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { withCleanup } from '@/lib/while-pending';

import type { ViewState } from './clone-view-state';

const log = createClientLogger('clone-repo-view');

/** The repo browser's state: results, search query, pagination and highlight. */
export function useRepoListState() {
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  // Highlight resets when the debounced query changes (new result set).
  const [highlightedIndex, setHighlightedIndex] = useResettableState(-1, [debouncedSearch]);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const loadingRef = useRef(false);
  const fetchIdRef = useRef(0);
  const pageRef = useRef(1);
  return {
    repos,
    setRepos,
    search,
    setSearch,
    debouncedSearch,
    setDebouncedSearch,
    hasMore,
    setHasMore,
    loadingRepos,
    setLoadingRepos,
    highlightedIndex,
    setHighlightedIndex,
    listRef,
    sentinelRef,
    debounceRef,
    loadingRef,
    fetchIdRef,
    pageRef,
  };
}

type RepoListState = ReturnType<typeof useRepoListState>;

/**
 * Loads the repo browser's results: debounced server-side search, infinite
 * scroll, and keyboard navigation of the list. `onSelect` picks a repository.
 */
export function useRepoFeed(
  view: ViewState,
  state: RepoListState,
  onSelect: (repo: GitHubRepo) => void,
) {
  const {
    repos,
    setRepos,
    search,
    debouncedSearch,
    setDebouncedSearch,
    hasMore,
    setHasMore,
    setLoadingRepos,
    highlightedIndex,
    setHighlightedIndex,
    listRef,
    sentinelRef,
    debounceRef,
    loadingRef,
    fetchIdRef,
    pageRef,
  } = state;

  // Load repos with optional server-side search. `append` keeps existing
  // results when paginating; stale responses are dropped via fetchIdRef.
  const fetchRepos = useCallback(
    async (pageNum: number, searchQuery: string, append: boolean) => {
      const fetchId = ++fetchIdRef.current;
      loadingRef.current = true;
      setLoadingRepos(true);
      log.debug('github repo search', { page: pageNum, query: searchQuery, append });
      return withCleanup(
        async () => {
          const result = await api.githubRepos({
            page: pageNum,
            per_page: 30,
            sort: 'updated',
            search: searchQuery || undefined,
          });
          if (fetchId !== fetchIdRef.current) return;
          if (result.isOk()) {
            setRepos((prev) => (append ? [...prev, ...result.value.repos] : result.value.repos));
            setHasMore(result.value.hasMore);
          }
        },
        () => {
          if (fetchId === fetchIdRef.current) {
            loadingRef.current = false;
            setLoadingRepos(false);
          }
        },
      );
    },
    [fetchIdRef, loadingRef, setLoadingRepos, setRepos, setHasMore],
  );

  // Debounce the search input to avoid firing a GitHub search on every keystroke.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, debounceRef, setDebouncedSearch]);

  // Keyboard navigation for repo list
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.min(prev + 1, repos.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && highlightedIndex >= 0 && highlightedIndex < repos.length) {
      e.preventDefault();
      onSelect(repos[highlightedIndex]);
    }
  };

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex < 0 || !listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-repo-item]');
    items[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, listRef]);

  // Load repos when entering repo view or the debounced search changes.
  // Always reset pagination to page 1 for a fresh result set.
  useEffect(() => {
    if (view !== 'repos') return;
    pageRef.current = 1;
    fetchRepos(1, debouncedSearch, false);
  }, [view, debouncedSearch, fetchRepos, pageRef]);

  // Infinite scroll: when the sentinel enters the viewport, fetch the next page.
  useEffect(() => {
    if (view !== 'repos') return;
    const root = listRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;

    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        if (loadingRef.current || !hasMore) return;
        const next = pageRef.current + 1;
        pageRef.current = next;
        fetchRepos(next, debouncedSearch, true);
      },
      { root, rootMargin: '0px 0px 200px 0px', threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [view, hasMore, debouncedSearch, fetchRepos, listRef, sentinelRef, loadingRef, pageRef]);

  return { handleSearchKeyDown };
}
