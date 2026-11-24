import { useEffect, useState } from 'react';

type SortField = 'updated' | 'created';
type SortDir = 'desc' | 'asc';

/**
 * The All Threads filter state, seeded from the URL query and kept in sync
 * with it when the URL changes (browser back/forward, deep links).
 */
export function useAllThreadsFilters(searchParams: URLSearchParams) {
  // Project filter from URL query param ?project=<id>
  const [projectFilter, setProjectFilter] = useState<string | null>(() => {
    return searchParams.get('project') || null;
  });
  const [projectFilterOpen, setProjectFilterOpen] = useState(false);

  const [search, setSearch] = useState(() => searchParams.get('search') || '');
  const [caseSensitive, setCaseSensitive] = useState(() => searchParams.get('cs') === '1');
  const [statusFilter, setStatusFilter] = useState<Set<string>>(() => {
    const paramStatus = searchParams.get('status');
    if (paramStatus) return new Set(paramStatus.split(',').filter(Boolean));
    return new Set();
  });
  const [gitFilter, setGitFilter] = useState<Set<string>>(new Set());
  const [modeFilter, setModeFilter] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<Set<string>>(() =>
    searchParams.get('scratch') === '1' ? new Set(['scratch']) : new Set(),
  );
  const [showArchived, setShowArchived] = useState(false);
  const [sortField, setSortField] = useState<SortField>(() => {
    const paramSort = searchParams.get('sort');
    if (paramSort === 'created' || paramSort === 'updated') return paramSort;
    return 'updated';
  });
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    const paramDir = searchParams.get('dir');
    if (paramDir === 'asc' || paramDir === 'desc') return paramDir;
    return 'desc';
  });

  // Sync URL query params → local state when URL changes (e.g. browser back/forward)
  useEffect(() => {
    const paramProject = searchParams.get('project') || null;
    const paramStatus = searchParams.get('status');

    // Setting the value a state already holds is a no-op, so no comparison is needed.
    setProjectFilter(paramProject);

    // Restore the text search from the URL (back button from a thread,
    // browser back/forward, deep links).
    const paramSearch = searchParams.get('search') ?? '';
    setSearch(paramSearch);
    const paramCs = searchParams.get('cs') === '1';
    setCaseSensitive(paramCs);

    // When ?status= param is present, force list view and pre-set status filter
    if (paramStatus) {
      const statuses = paramStatus.split(',').filter(Boolean);
      setStatusFilter(new Set(statuses));
    }

    // Sync ?scratch=1 → typeFilter
    const paramScratch = searchParams.get('scratch') === '1';
    setTypeFilter((prev) => syncScratchFilter(prev, paramScratch));

    // Sync sort params from URL
    const paramSort = searchParams.get('sort');
    if (paramSort === 'created' || paramSort === 'updated') {
      setSortField(paramSort);
    }
    const paramDir = searchParams.get('dir');
    if (paramDir === 'asc' || paramDir === 'desc') {
      setSortDir(paramDir);
    }
  }, [searchParams]);

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
    showArchived,
    setShowArchived,
    sortField,
    setSortField,
    sortDir,
    setSortDir,
  };
}

function syncScratchFilter(previous: Set<string>, scratch: boolean): Set<string> {
  const hasScratch = previous.has('scratch');
  if (scratch && !hasScratch) return new Set(['scratch']);
  if (!scratch && previous.size === 1 && hasScratch) return new Set();
  return previous;
}
