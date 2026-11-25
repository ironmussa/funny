import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetURLSearchParams } from 'react-router-dom';

import {
  parseListFilters,
  writeListFilters,
  type ListFilters,
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
  const [projectFilter, setProjectFilter] = useState<string | null>(
    () => urlSearchState(searchParams).project,
  );
  const [projectFilterOpen, setProjectFilterOpen] = useState(false);

  const [search, setSearch] = useState(() => urlSearchState(searchParams).search);
  const [caseSensitive, setCaseSensitive] = useState(
    () => urlSearchState(searchParams).caseSensitive,
  );
  const list = useListFilterState(searchParams);
  const { setStatusFilter, setGitFilter, setModeFilter, setTypeFilter, setOriginFilter } = list;
  const { setShowArchived, setSortField, setSortDir } = list;

  // Sync URL query params → local state when URL changes (e.g. browser back/forward).
  // Adjusted during render (react.dev "you might not need an effect"): the state
  // initializers above already read the first URL, so only a change is applied.
  const [syncedSearchParams, setSyncedSearchParams] = useState(searchParams);
  if (syncedSearchParams !== searchParams) {
    setSyncedSearchParams(searchParams);
    // Setting the value a state already holds is a no-op, so no comparison is needed.
    const fromUrl = urlSearchState(searchParams);
    setProjectFilter(fromUrl.project);
    // Restore the text search from the URL (back button from a thread,
    // browser back/forward, deep links).
    setSearch(fromUrl.search);
    setCaseSensitive(fromUrl.caseSensitive);
    const filters = parseListFilters(searchParams);
    setStatusFilter(keepIfSame(filters.status));
    setGitFilter(keepIfSame(filters.git));
    setModeFilter(keepIfSame(filters.mode));
    setTypeFilter(keepIfSame(filters.type));
    setOriginFilter(keepIfSame(filters.origin));
    setShowArchived(filters.showArchived);
    setSortField(filters.sortField);
    setSortDir(filters.sortDir);
  }

  useFiltersToUrl(searchParams, setSearchParams, viewMode, {
    status: list.statusFilter,
    git: list.gitFilter,
    mode: list.modeFilter,
    type: list.typeFilter,
    origin: list.originFilter,
    showArchived: list.showArchived,
    sortField: list.sortField,
    sortDir: list.sortDir,
  });

  const handleTypeToggle = useCallback(
    (value: string) => {
      setTypeFilter(toggle(value));
    },
    [setTypeFilter],
  );

  const handleOriginToggle = useCallback(
    (value: string) => {
      setOriginFilter(toggle(value));
    },
    [setOriginFilter],
  );

  return {
    projectFilter,
    setProjectFilter,
    projectFilterOpen,
    setProjectFilterOpen,
    search,
    setSearch,
    caseSensitive,
    setCaseSensitive,
    ...list,
    handleTypeToggle,
    handleOriginToggle,
  };
}

/**
 * The list filters (status, git, mode, type, origin, archived, sort). Every
 * one lives in the URL too (`list-filter-params.ts`), so opening a thread and
 * coming back (header back button, browser back) restores them.
 */
function useListFilterState(searchParams: URLSearchParams) {
  const [initialFilters] = useState(() => parseListFilters(searchParams));
  const [statusFilter, setStatusFilter] = useState<Set<string>>(initialFilters.status);
  const [gitFilter, setGitFilter] = useState<Set<string>>(initialFilters.git);
  const [modeFilter, setModeFilter] = useState<Set<string>>(initialFilters.mode);
  const [typeFilter, setTypeFilter] = useState<Set<string>>(initialFilters.type);
  const [originFilter, setOriginFilter] = useState<Set<string>>(initialFilters.origin);
  const [showArchived, setShowArchived] = useState(initialFilters.showArchived);
  const [sortField, setSortField] = useState<SortField>(initialFilters.sortField);
  const [sortDir, setSortDir] = useState<SortDir>(initialFilters.sortDir);
  return {
    statusFilter,
    setStatusFilter,
    gitFilter,
    setGitFilter,
    modeFilter,
    setModeFilter,
    typeFilter,
    setTypeFilter,
    originFilter,
    setOriginFilter,
    showArchived,
    setShowArchived,
    sortField,
    setSortField,
    sortDir,
    setSortDir,
  };
}

/**
 * Local filter state → URL. Reads the params through a ref so a URL change
 * (handled by the URL → state effect) never writes the previous filters back.
 */
function useFiltersToUrl(
  searchParams: URLSearchParams,
  setSearchParams: SetURLSearchParams,
  viewMode: 'list' | 'board',
  filters: ListFilters,
) {
  const searchParamsRef = useRef(searchParams);
  useEffect(() => {
    searchParamsRef.current = searchParams;
  }, [searchParams]);
  const { status, git, mode, type, origin, showArchived, sortField, sortDir } = filters;
  useEffect(() => {
    const next = filtersUrlUpdate(searchParamsRef.current, viewMode, {
      status,
      git,
      mode,
      type,
      origin,
      showArchived,
      sortField,
      sortDir,
    });
    if (next) setSearchParams(next, { replace: true });
  }, [
    viewMode,
    status,
    git,
    mode,
    type,
    origin,
    showArchived,
    sortField,
    sortDir,
    setSearchParams,
  ]);
}

/** The project, text search and case flag the URL holds. */
function urlSearchState(params: URLSearchParams) {
  return {
    project: params.get('project') || null,
    search: params.get('search') ?? '',
    caseSensitive: params.get('cs') === '1',
  };
}

/**
 * The URL with `filters` written in, or `null` when it already holds them.
 * `?status=` turns the board into the list: leave the board's URL alone.
 */
function filtersUrlUpdate(
  current: URLSearchParams,
  viewMode: 'list' | 'board',
  filters: ListFilters,
): URLSearchParams | null {
  if (viewMode !== 'list') return null;
  const next = writeListFilters(current, filters);
  return next.toString() !== current.toString() ? next : null;
}

/**
 * A state updater that takes `next` when it holds other values than the
 * current set, else keeps the current one (no re-render).
 */
function keepIfSame(next: Set<string>) {
  return (prev: Set<string>): Set<string> =>
    prev.size === next.size && [...prev].every((v) => next.has(v)) ? prev : next;
}

/** A state updater that adds `value` to the set, or removes it when it was there. */
function toggle(value: string) {
  return (set: Set<string>): Set<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };
}
