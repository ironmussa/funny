import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetURLSearchParams } from 'react-router-dom';

import {
  parseListFilters,
  writeListFilters,
  type SortDir,
  type SortField,
} from '@/components/all-threads/list-filter-params';

/**
 * The All Threads filter state, seeded from the URL query and kept in sync
 * with it both ways: a URL change (browser back/forward, deep links) updates
 * the state, and a filter change in the list view is written to the URL.
 */
export function useAllThreadsFilters(
  searchParams: URLSearchParams,
  setSearchParams: SetURLSearchParams,
  viewMode: 'list' | 'board',
) {
  // Project filter from URL query param ?project=<id>
  const [projectFilter, setProjectFilter] = useState<string | null>(() => {
    return searchParams.get('project') || null;
  });
  const [projectFilterOpen, setProjectFilterOpen] = useState(false);

  const [search, setSearch] = useState(() => searchParams.get('search') || '');
  const [caseSensitive, setCaseSensitive] = useState(() => searchParams.get('cs') === '1');
  // Every filter lives in the URL too (`list-filter-params.ts`), so opening a
  // thread and coming back (header back button, browser back) restores them.
  const [initialFilters] = useState(() => parseListFilters(searchParams));
  const [statusFilter, setStatusFilter] = useState<Set<string>>(initialFilters.status);
  const [gitFilter, setGitFilter] = useState<Set<string>>(initialFilters.git);
  const [modeFilter, setModeFilter] = useState<Set<string>>(initialFilters.mode);
  const [typeFilter, setTypeFilter] = useState<Set<string>>(initialFilters.type);
  const [originFilter, setOriginFilter] = useState<Set<string>>(initialFilters.origin);
  const [showArchived, setShowArchived] = useState(initialFilters.showArchived);
  const [sortField, setSortField] = useState<SortField>(initialFilters.sortField);
  const [sortDir, setSortDir] = useState<SortDir>(initialFilters.sortDir);

  // Sync URL query params → local state when URL changes (e.g. browser back/forward)
  useEffect(() => {
    // Setting the value a state already holds is a no-op, so no comparison is needed.
    setProjectFilter(searchParams.get('project') || null);
    // Restore the text search from the URL (back button from a thread,
    // browser back/forward, deep links).
    setSearch(searchParams.get('search') ?? '');
    setCaseSensitive(searchParams.get('cs') === '1');
    const filters = parseListFilters(searchParams);
    setStatusFilter((prev) => sameSet(prev, filters.status));
    setGitFilter((prev) => sameSet(prev, filters.git));
    setModeFilter((prev) => sameSet(prev, filters.mode));
    setTypeFilter((prev) => sameSet(prev, filters.type));
    setOriginFilter((prev) => sameSet(prev, filters.origin));
    setShowArchived(filters.showArchived);
    setSortField(filters.sortField);
    setSortDir(filters.sortDir);
  }, [searchParams]);

  // Local filter state → URL. Reads the params through a ref so a URL change
  // (handled above) never writes the previous filters back.
  const searchParamsRef = useRef(searchParams);
  useEffect(() => {
    searchParamsRef.current = searchParams;
  }, [searchParams]);
  useEffect(() => {
    // `?status=` turns the board into the list: leave the board's URL alone.
    if (viewMode !== 'list') return;
    const current = searchParamsRef.current;
    const next = writeListFilters(current, {
      status: statusFilter,
      git: gitFilter,
      mode: modeFilter,
      type: typeFilter,
      origin: originFilter,
      showArchived,
      sortField,
      sortDir,
    });
    if (next.toString() !== current.toString()) setSearchParams(next, { replace: true });
  }, [
    viewMode,
    statusFilter,
    gitFilter,
    modeFilter,
    typeFilter,
    originFilter,
    showArchived,
    sortField,
    sortDir,
    setSearchParams,
  ]);

  const handleTypeToggle = useCallback((value: string) => {
    setTypeFilter((prev) => toggled(prev, value));
  }, []);

  const handleOriginToggle = useCallback((value: string) => {
    setOriginFilter((prev) => toggled(prev, value));
  }, []);

  return {
    projectFilter,
    setProjectFilter,
    projectFilterOpen,
    setProjectFilterOpen,
    search,
    setSearch,
    caseSensitive,
    setCaseSensitive,
    statusFilter,
    setStatusFilter,
    gitFilter,
    setGitFilter,
    modeFilter,
    setModeFilter,
    typeFilter,
    setTypeFilter,
    handleTypeToggle,
    originFilter,
    setOriginFilter,
    handleOriginToggle,
    showArchived,
    setShowArchived,
    sortField,
    setSortField,
    sortDir,
    setSortDir,
  };
}

/** `next` when it holds other values than `prev`, else `prev` (no re-render). */
function sameSet(prev: Set<string>, next: Set<string>): Set<string> {
  return prev.size === next.size && [...prev].every((v) => next.has(v)) ? prev : next;
}

/** `set` with `value` added, or removed when it was there. */
function toggled(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
