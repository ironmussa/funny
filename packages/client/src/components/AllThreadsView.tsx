import type { GitSyncState, Thread, ThreadStatus } from '@funny/shared';
import { ChevronLeft, Columns3, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { AllThreadsContent } from '@/components/all-threads/AllThreadsContent';
import { AllThreadsToolbar } from '@/components/all-threads/AllThreadsToolbar';
import {
  parseListFilters,
  writeListFilters,
  type SortDir,
  type SortField,
} from '@/components/all-threads/list-filter-params';
import { normalize } from '@/components/ui/highlight-text';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { useGitStatusMaps } from '@/data/git-status/hooks';
import { statusBranchKeyForThread } from '@/data/git-status/keys';
import { useProjects } from '@/data/projects/hooks';
import { useLoadedThreads, useProjectListTotals } from '@/data/threads/hooks';
import { readThreadRow } from '@/data/threads/read';
import { useGitStatusScope } from '@/hooks/use-git-status-scope';
import { useThreadContentSearch } from '@/hooks/use-thread-content-search';
import { useThreadsByProject } from '@/lib/thread-selectors';
import { isFactoryThread, isScratch } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { whilePending } from '@/lib/while-pending';
import { buildThreadPath } from '@/navigation/thread-paths';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const THREAD_STATUSES: ThreadStatus[] = [
  'running',
  'waiting',
  'completed',
  'failed',
  'stopped',
  'pending',
  'interrupted',
];
const GIT_STATES: GitSyncState[] = ['dirty', 'unpushed', 'pushed', 'merged', 'clean'];

export function AllThreadsView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const allThreadsProjectId = useUIStore((s) => s.allThreadsProjectId);
  const threadsByProject = useThreadsByProject();
  const threadTotalByProject = useProjectListTotals();
  const loadMoreThreads = useThreadStore((s) => s.loadMoreThreads);
  const projects = useProjects();
  const { statusByBranch, threadToBranchKey } = useGitStatusMaps();
  // Filters and sorts by git state across every loaded thread.
  useGitStatusScope({ all: true, projectIds: Object.keys(threadsByProject) });

  // View mode derived from pathname: /kanban = board, /list (or anything else) = list
  // When ?status= param is present, force list view
  const viewMode: 'list' | 'board' = searchParams.get('status')
    ? 'list'
    : location.pathname === '/kanban'
      ? 'board'
      : 'list';

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

  // The current params with project / search / case overridden; every other
  // param (the filters, returnThread, highlight) is kept.
  const buildSearchParams = (overrides?: {
    project?: string | null;
    search?: string;
    cs?: boolean;
  }) => {
    const params = new URLSearchParams(searchParams);
    const proj = overrides?.project !== undefined ? overrides.project : projectFilter;
    if (proj) params.set('project', proj);
    else params.delete('project');
    // Text search lives in the URL so back-navigation from a thread (and
    // browser back/forward) restores the query.
    const q = overrides?.search !== undefined ? overrides.search : search;
    if (q.trim()) params.set('search', q);
    else params.delete('search');
    const cs = overrides?.cs !== undefined ? overrides.cs : caseSensitive;
    if (cs) params.set('cs', '1');
    else params.delete('cs');
    if (proj !== projectFilter) params.delete('returnThread');
    return params;
  };

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

  const filteredProject = projectFilter ? projects.find((p) => p.id === projectFilter) : null;

  const handleProjectFilterChange = (projectId: string | null) => {
    setProjectFilter(projectId);
    setSearchParams(buildSearchParams({ project: projectId }), {
      replace: true,
    });
  };

  const handleTypeToggle = useCallback((value: string) => {
    setTypeFilter((prev) => toggled(prev, value));
  }, []);

  const handleOriginToggle = useCallback((value: string) => {
    setOriginFilter((prev) => toggled(prev, value));
  }, []);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchKeyDownRef = useRef<((e: React.KeyboardEvent) => void) | null>(null);
  // Auto-focus search input on mount (e.g. when navigating via Ctrl+F)
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // ESC with empty search: jump back to the last thread the user was viewing,
  // or fall back to the filtered project / root. When the query has text,
  // SearchBar handles ESC by clearing it first.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (search.trim()) return;
      const threadStore = useThreadStore.getState();
      const last = threadStore.activeThread;
      e.preventDefault();
      if (last) {
        navigate(buildPath(`/projects/${last.projectId}/threads/${last.id}`));
        return;
      }
      const lastId = threadStore.selectedThreadId;
      if (lastId && projectFilter) {
        navigate(buildPath(`/projects/${projectFilter}/threads/${lastId}`));
        return;
      }
      if (projectFilter) {
        navigate(buildPath(`/projects/${projectFilter}`));
        return;
      }
      navigate(buildPath('/'));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [search, navigate, projectFilter]);

  // Fetch threads including archived when either the archived toggle is on OR
  // we're in board view (the Kanban "Archived" column needs them loaded to be
  // populated). Initial loads elsewhere use includeArchived=false; this tops
  // the buckets up, and replaceProjectThreads keeps archived resident across
  // later non-archived refreshes.
  useEffect(() => {
    if (!showArchived && viewMode !== 'board') return;
    const targets = projectFilter ? [projectFilter] : projects.map((p) => p.id);
    for (const pid of targets) {
      useThreadStore.getState().loadThreadsForProject(pid, true);
    }
  }, [showArchived, viewMode, projectFilter, projects]);

  const contentMatches = useThreadContentSearch(search, projectFilter, caseSensitive);

  const projectInfoById = useMemo(() => {
    const map: Record<string, { name: string; path: string; color?: string }> = {};
    for (const p of projects) map[p.id] = { name: p.name, path: p.path, color: p.color };
    return map;
  }, [projects]);
  const projectNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of projects) map[p.id] = p.name;
    return map;
  }, [projects]);

  // Rows come from a live query over the threads collection: one project's
  // list, or every loaded project plus scratch.
  const storeThreads = useLoadedThreads(projectFilter);

  // Check if any relevant project has more threads on the server than loaded
  const scratchOnlyFilter = typeFilter.size === 1 && typeFilter.has('scratch');
  const hasMoreServerThreads = useMemo(() => {
    if (scratchOnlyFilter) return false;
    const relevantProjects = projectFilter ? [projectFilter] : projects.map((p) => p.id);
    return relevantProjects.some((pid) => {
      const loaded = (threadsByProject[pid] ?? []).length;
      const total = threadTotalByProject[pid] ?? 0;
      return loaded < total;
    });
  }, [threadsByProject, threadTotalByProject, projectFilter, projects, scratchOnlyFilter]);

  const [loadingMore, setLoadingMore] = useState(false);
  const handleLoadMore = useCallback(async () => {
    await whilePending(setLoadingMore, async () => {
      const relevantProjects = projectFilter ? [projectFilter] : projects.map((p) => p.id);
      await Promise.all(
        relevantProjects.flatMap((projectId) =>
          (threadsByProject[projectId] ?? []).length < (threadTotalByProject[projectId] ?? 0)
            ? [loadMoreThreads(projectId, showArchived)]
            : [],
        ),
      );
    });
  }, [
    projectFilter,
    projects,
    threadsByProject,
    threadTotalByProject,
    loadMoreThreads,
    showArchived,
  ]);

  const allThreads = useMemo(() => {
    // Board view always includes archived (they appear in the archived column)
    if (viewMode === 'board') return storeThreads;
    // List view: filter out archived unless showArchived is toggled on
    if (showArchived) return storeThreads;
    return storeThreads.filter((t) => !t.archived);
  }, [storeThreads, showArchived, viewMode]);

  const filtered = useMemo(() => {
    let result = allThreads;

    // Text search — matches title, branch, status, project name, OR message content.
    // Case-insensitive by default (also strips accents); case-sensitive uses raw substring match.
    if (search.trim()) {
      const matches = caseSensitive
        ? (text: string | undefined | null) => !!text && text.includes(search)
        : (
            (q) => (text: string | undefined | null) =>
              !!text && normalize(text).includes(q)
          )(normalize(search));
      result = result.filter(
        (t) =>
          matches(t.title) ||
          matches(t.branch) ||
          matches(t.status) ||
          (!projectFilter && matches(projectNameById[t.projectId])) ||
          contentMatches.has(t.id),
      );
    }

    // Status filter (multi-select)
    if (statusFilter.size > 0) {
      result = result.filter((t) => statusFilter.has(t.status));
    }

    // Git status filter (multi-select)
    if (gitFilter.size > 0) {
      result = result.filter((t) => {
        const gs = statusByBranch[statusBranchKeyForThread(t, threadToBranchKey)];
        return gs ? gitFilter.has(gs.state) : false;
      });
    }

    // Mode filter (multi-select)
    if (modeFilter.size > 0) {
      result = result.filter((t) => modeFilter.has(t.mode));
    }

    // Type filter (scratch vs normal)
    if (typeFilter.size > 0) {
      result = result.filter((t) => typeFilter.has(isScratch(t) ? 'scratch' : 'normal'));
    }

    // Origin filter (started by the issue factory vs by a person)
    if (originFilter.size > 0) {
      result = result.filter((t) => originFilter.has(threadOrigin(t)));
    }

    // Sort by selected field and direction
    result = result.toSorted((a, b) => {
      const dateA = sortField === 'updated' ? (a.completedAt ?? a.createdAt) : a.createdAt;
      const dateB = sortField === 'updated' ? (b.completedAt ?? b.createdAt) : b.createdAt;
      const diff = new Date(dateA).getTime() - new Date(dateB).getTime();
      return sortDir === 'desc' ? -diff : diff;
    });

    return result;
  }, [
    allThreads,
    search,
    caseSensitive,
    statusFilter,
    gitFilter,
    modeFilter,
    typeFilter,
    originFilter,
    statusByBranch,
    threadToBranchKey,
    projectFilter,
    projectNameById,
    sortField,
    sortDir,
    contentMatches,
  ]);

  const resetFilters = () => {
    setSearch('');
    setStatusFilter(new Set());
    setGitFilter(new Set());
    setModeFilter(new Set());
    setTypeFilter(new Set());
    setOriginFilter(new Set());
    setShowArchived(false);
    if (projectFilter) {
      setProjectFilter(null);
    }
    setSearchParams(buildSearchParams({ project: null, search: '', cs: false }), {
      replace: true,
    });
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
    // Mirror the query into the URL (replace — no history churn per keystroke)
    // so leaving the view and coming back restores the search.
    setSearchParams(buildSearchParams({ search: value }), { replace: true });
  };

  const handleCaseSensitiveChange = (value: boolean) => {
    setCaseSensitive(value);
    setSearchParams(buildSearchParams({ cs: value }), { replace: true });
  };

  const handleBack = useCallback(() => {
    const returnThreadId = searchParams.get('returnThread');
    if (returnThreadId) {
      const returnThread = readThreadRow(returnThreadId);
      if (returnThread) {
        navigate(buildThreadPath(returnThread));
        return;
      }
      if (projectFilter) {
        navigate(buildPath(`/projects/${projectFilter}/threads/${returnThreadId}`));
        return;
      }
    }
    if (projectFilter) {
      navigate(buildPath(`/projects/${projectFilter}`));
    }
  }, [navigate, projectFilter, searchParams]);

  const hasActiveFilters =
    statusFilter.size > 0 ||
    gitFilter.size > 0 ||
    modeFilter.size > 0 ||
    typeFilter.size > 0 ||
    originFilter.size > 0 ||
    showArchived ||
    !!projectFilter;

  // Counts for type filter (scratch vs normal)
  const typeCounts = useMemo(() => {
    const counts = { scratch: 0, normal: 0 };
    for (const t of allThreads) {
      counts[isScratch(t) ? 'scratch' : 'normal']++;
    }
    return counts;
  }, [allThreads]);

  // Counts for the origin filter (factory vs user)
  const originCounts = useMemo(() => {
    const counts = { factory: 0, user: 0 };
    for (const t of allThreads) counts[threadOrigin(t)]++;
    return counts;
  }, [allThreads]);

  // Compute counts for status filters
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of allThreads) {
      counts[t.status] = (counts[t.status] || 0) + 1;
    }
    return counts;
  }, [allThreads]);

  // Compute counts for git status filters
  const gitCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of allThreads) {
      const gs = statusByBranch[statusBranchKeyForThread(t, threadToBranchKey)];
      if (gs) {
        counts[gs.state] = (counts[gs.state] || 0) + 1;
      }
    }
    return counts;
  }, [allThreads, statusByBranch, threadToBranchKey]);

  if (!allThreadsProjectId) return null;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* Header */}
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
        {projectFilter && (
          <TooltipIconButton
            variant="muted"
            data-testid="all-threads-back"
            onClick={handleBack}

            tooltip={t('common.back')}
          >
            <ChevronLeft className="icon-base" />
          </TooltipIconButton>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            {viewMode === 'board' ? (
              <Columns3 className="icon-sm text-muted-foreground" />
            ) : (
              <Search className="icon-sm text-muted-foreground" />
            )}
            {scratchOnlyFilter
              ? t('sidebar.scratchTitle', { defaultValue: 'Quick Chats' })
              : projectFilter && filteredProject
                ? t('allThreads.title')
                : t('allThreads.globalTitle')}
          </h2>
          <p className="text-muted-foreground text-sm">
            {scratchOnlyFilter
              ? `${allThreads.length} ${t('allThreads.threads')}`
              : projectFilter && filteredProject
                ? `${filteredProject.name} · ${allThreads.length} ${t('allThreads.threads')}`
                : `${projects.length} ${t('allThreads.projects')} · ${allThreads.length} ${t('allThreads.threads')}`}
          </p>
        </div>
      </div>

      <AllThreadsToolbar
        searchInputRef={searchInputRef}
        search={search}
        onSearchChange={handleSearchChange}
        caseSensitive={caseSensitive}
        onCaseSensitiveChange={handleCaseSensitiveChange}
        searchKeyDown={(e) => searchKeyDownRef.current?.(e)}
        filteredCount={filtered.length}
        totalCount={allThreads.length}
        searchPlaceholder={
          projectFilter
            ? t('allThreads.searchPlaceholder')
            : t('allThreads.globalSearchPlaceholder')
        }
        projects={projects}
        projectFilter={projectFilter}
        filteredProjectName={filteredProject?.name}
        projectFilterOpen={projectFilterOpen}
        setProjectFilterOpen={setProjectFilterOpen}
        onProjectFilterChange={handleProjectFilterChange}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        gitFilter={gitFilter}
        setGitFilter={setGitFilter}
        modeFilter={modeFilter}
        setModeFilter={setModeFilter}
        typeFilter={typeFilter}
        onTypeToggle={handleTypeToggle}
        typeCounts={typeCounts}
        originFilter={originFilter}
        onOriginToggle={handleOriginToggle}
        originCounts={originCounts}
        statusCounts={statusCounts}
        gitCounts={gitCounts}
        threadStatuses={THREAD_STATUSES}
        gitStates={GIT_STATES}
        sortField={sortField}
        setSortField={setSortField}
        sortDir={sortDir}
        setSortDir={setSortDir}
        showArchived={showArchived}
        setShowArchived={setShowArchived}
        hasActiveFilters={hasActiveFilters}
        onResetFilters={resetFilters}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <AllThreadsContent
          viewMode={viewMode}
          threads={filtered}
          search={search}
          caseSensitive={caseSensitive}
          contentMatches={contentMatches}
          highlightThreadId={searchParams.get('highlight') || undefined}
          projectFilter={projectFilter}
          projectInfoById={projectInfoById}
          hasMoreServerThreads={hasMoreServerThreads}
          loadingMore={loadingMore}
          onLoadMore={handleLoadMore}
          searchKeyDownRef={searchKeyDownRef}
        />
      </div>
    </div>
  );
}

/** Who started a thread, as the origin filter names it. */
function threadOrigin(thread: Thread): 'factory' | 'user' {
  return isFactoryThread(thread) ? 'factory' : 'user';
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
