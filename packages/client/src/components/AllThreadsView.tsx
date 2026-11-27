import type { GitSyncState, ThreadStatus } from '@funny/shared';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { AllThreadsContent } from '@/components/all-threads/AllThreadsContent';
import { AllThreadsHeader } from '@/components/all-threads/AllThreadsHeader';
import { AllThreadsToolbar } from '@/components/all-threads/AllThreadsToolbar';
import {
  buildAllThreadsSearchParams,
  type SearchParamOverrides,
} from '@/components/all-threads/search-params';
import {
  filterAndSortThreads,
  useThreadFilterCounts,
} from '@/components/all-threads/thread-filters';
import { useAllThreadsBack } from '@/components/all-threads/use-all-threads-back';
import { useAllThreadsFilters } from '@/components/all-threads/use-all-threads-filters';
import { useEscapeToLastThread } from '@/components/all-threads/use-escape-to-last-thread';
import { useLoadMoreServerThreads } from '@/components/all-threads/use-load-more-server-threads';
import { useAllAutomations } from '@/data/automations/hooks';
import { loadAllAutomations } from '@/data/automations/loaders';
import { useGitStatusMaps } from '@/data/git-status/hooks';
import { useProjects } from '@/data/projects/hooks';
import { useLoadedThreads, useProjectListTotals } from '@/data/threads/hooks';
import { useGitStatusScope } from '@/hooks/use-git-status-scope';
import { useThreadContentSearch } from '@/hooks/use-thread-content-search';
import { useThreadsByProject } from '@/lib/thread-selectors';
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
  const filters = useAllThreadsFilters(searchParams, setSearchParams, viewMode);
  const { projectFilter, search, caseSensitive, statusFilter, gitFilter, modeFilter } = filters;
  const { typeFilter, originFilter, automationFilter, showArchived, sortField, sortDir } = filters;

  const buildSearchParams = (overrides?: SearchParamOverrides) =>
    buildAllThreadsSearchParams(searchParams, { projectFilter, search, caseSensitive }, overrides);

  const filteredProject = projectFilter ? projects.find((p) => p.id === projectFilter) : null;

  const handleProjectFilterChange = (projectId: string | null) => {
    filters.setProjectFilter(projectId);
    setSearchParams(buildSearchParams({ project: projectId }), {
      replace: true,
    });
  };

  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchKeyDownRef = useRef<((e: React.KeyboardEvent) => void) | null>(null);
  // Auto-focus search input on mount (e.g. when navigating via Ctrl+F)
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  useEscapeToLastThread(search, navigate, projectFilter);

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
  const { hasMoreServerThreads, loadingMore, handleLoadMore } = useLoadMoreServerThreads({
    scratchOnlyFilter,
    projectFilter,
    projects,
    threadsByProject,
    totalsByProject: threadTotalByProject,
    loadMoreThreads,
    showArchived,
  });

  const allThreads = useMemo(() => {
    // Board view always includes archived (they appear in the archived column)
    if (viewMode === 'board') return storeThreads;
    // List view: filter out archived unless showArchived is toggled on
    if (showArchived) return storeThreads;
    return storeThreads.filter((t) => !t.archived);
  }, [storeThreads, showArchived, viewMode]);

  const filtered = useMemo(
    () =>
      filterAndSortThreads({
        allThreads,
        search,
        caseSensitive,
        statusFilter,
        gitFilter,
        modeFilter,
        typeFilter,
        originFilter,
        automationFilter,
        statusByBranch,
        threadToBranchKey,
        projectFilter,
        projectNameById,
        sortField,
        sortDir,
        contentMatches,
      }),
    [
      allThreads,
      search,
      caseSensitive,
      statusFilter,
      gitFilter,
      modeFilter,
      typeFilter,
      originFilter,
      automationFilter,
      statusByBranch,
      threadToBranchKey,
      projectFilter,
      projectNameById,
      sortField,
      sortDir,
      contentMatches,
    ],
  );

  const resetFilters = () => {
    filters.setSearch('');
    filters.setStatusFilter(new Set());
    filters.setGitFilter(new Set());
    filters.setModeFilter(new Set());
    filters.setTypeFilter(new Set());
    filters.setOriginFilter(new Set());
    filters.setAutomationFilter(new Set());
    filters.setShowArchived(false);
    if (projectFilter) {
      filters.setProjectFilter(null);
    }
    setSearchParams(buildSearchParams({ project: null, search: '', cs: false }), {
      replace: true,
    });
  };

  const handleSearchChange = (value: string) => {
    filters.setSearch(value);
    // Mirror the query into the URL (replace — no history churn per keystroke)
    // so leaving the view and coming back restores the search.
    setSearchParams(buildSearchParams({ search: value }), { replace: true });
  };

  const handleCaseSensitiveChange = (value: boolean) => {
    filters.setCaseSensitive(value);
    setSearchParams(buildSearchParams({ cs: value }), { replace: true });
  };

  const handleBack = useAllThreadsBack(navigate, projectFilter, searchParams);

  const hasActiveFilters =
    statusFilter.size > 0 ||
    gitFilter.size > 0 ||
    modeFilter.size > 0 ||
    typeFilter.size > 0 ||
    originFilter.size > 0 ||
    automationFilter.size > 0 ||
    showArchived ||
    !!projectFilter;

  const { typeCounts, originCounts, automationCounts, statusCounts, gitCounts } =
    useThreadFilterCounts(allThreads, statusByBranch, threadToBranchKey);

  // Names for the automation filter. The rows come from the automations
  // collection, which only the settings screen loads otherwise.
  const automations = useAllAutomations();
  useEffect(() => {
    void loadAllAutomations();
  }, []);
  const automationOptions = useMemo(
    () =>
      automations.flatMap((a) =>
        (automationCounts[a.id] || 0) > 0 || automationFilter.has(a.id)
          ? [{ value: a.id, label: a.name, detail: projectNameById[a.projectId] }]
          : [],
      ),
    [automations, automationCounts, automationFilter, projectNameById],
  );

  if (!allThreadsProjectId) return null;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <AllThreadsHeader
        projectFilter={projectFilter}
        filteredProject={filteredProject}
        viewMode={viewMode}
        scratchOnlyFilter={scratchOnlyFilter}
        threadCount={allThreads.length}
        projectCount={projects.length}
        onBack={handleBack}
      />

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
        projectFilterOpen={filters.projectFilterOpen}
        setProjectFilterOpen={filters.setProjectFilterOpen}
        onProjectFilterChange={handleProjectFilterChange}
        statusFilter={statusFilter}
        setStatusFilter={filters.setStatusFilter}
        gitFilter={gitFilter}
        setGitFilter={filters.setGitFilter}
        modeFilter={modeFilter}
        setModeFilter={filters.setModeFilter}
        typeFilter={typeFilter}
        onTypeToggle={filters.handleTypeToggle}
        typeCounts={typeCounts}
        originFilter={originFilter}
        onOriginToggle={filters.handleOriginToggle}
        originCounts={originCounts}
        automationOptions={automationOptions}
        automationFilter={automationFilter}
        onAutomationToggle={filters.handleAutomationToggle}
        automationCounts={automationCounts}
        statusCounts={statusCounts}
        gitCounts={gitCounts}
        threadStatuses={THREAD_STATUSES}
        gitStates={GIT_STATES}
        sortField={sortField}
        setSortField={filters.setSortField}
        sortDir={sortDir}
        setSortDir={filters.setSortDir}
        showArchived={showArchived}
        setShowArchived={filters.setShowArchived}
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
