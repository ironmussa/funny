import type { GitSyncState, ThreadStatus } from '@funny/shared';
import { ChevronLeft, Columns3, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { AllThreadsContent } from '@/components/all-threads/AllThreadsContent';
import { AllThreadsToolbar } from '@/components/all-threads/AllThreadsToolbar';
import { normalize } from '@/components/ui/highlight-text';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { api } from '@/lib/api';
import { buildPath } from '@/lib/url';
import { branchKey as computeBranchKey, useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

type SortField = 'updated' | 'created';
type SortDir = 'desc' | 'asc';

export function AllThreadsView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const allThreadsProjectId = useUIStore((s) => s.allThreadsProjectId);
  const threadsByProject = useThreadStore((s) => s.threadsByProject);
  const threadTotalByProject = useThreadStore((s) => s.threadTotalByProject);
  const loadMoreThreads = useThreadStore((s) => s.loadMoreThreads);
  const projects = useProjectStore((s) => s.projects);
  const statusByBranch = useGitStatusStore((s) => s.statusByBranch);

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

  // Build search params from current filter state (preserves status/sort params if present)
  const buildSearchParams = (overrides?: { project?: string | null }) => {
    const params: Record<string, string> = {};
    const proj = overrides?.project !== undefined ? overrides.project : projectFilter;
    if (proj) params.project = proj;
    const statusParam = searchParams.get('status');
    if (statusParam) params.status = statusParam;
    const sortParam = searchParams.get('sort');
    if (sortParam) params.sort = sortParam;
    const dirParam = searchParams.get('dir');
    if (dirParam) params.dir = dirParam;
    return params;
  };

  // Sync URL query params → local state when URL changes (e.g. browser back/forward)
  useEffect(() => {
    const paramProject = searchParams.get('project') || null;
    const paramStatus = searchParams.get('status');

    if (paramProject !== projectFilter) {
      setProjectFilter(paramProject);
    }

    // When ?status= param is present, force list view and pre-set status filter
    if (paramStatus) {
      const statuses = paramStatus.split(',').filter(Boolean);
      setStatusFilter(new Set(statuses));
    }

    // Sync sort params from URL
    const paramSort = searchParams.get('sort');
    if (paramSort === 'created' || paramSort === 'updated') {
      setSortField(paramSort);
    }
    const paramDir = searchParams.get('dir');
    if (paramDir === 'asc' || paramDir === 'desc') {
      setSortDir(paramDir);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally syncs URL → state only when searchParams changes; adding projectFilter would loop
  }, [searchParams]);

  const filteredProject = projectFilter ? projects.find((p) => p.id === projectFilter) : null;

  const handleProjectFilterChange = (projectId: string | null) => {
    setProjectFilter(projectId);
    setSearchParams(buildSearchParams({ project: projectId }), { replace: true });
  };

  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchKeyDownRef = useRef<((e: React.KeyboardEvent) => void) | null>(null);
  const [search, setSearch] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [statusFilter, setStatusFilter] = useState<Set<string>>(() => {
    const paramStatus = searchParams.get('status');
    if (paramStatus) return new Set(paramStatus.split(',').filter(Boolean));
    return new Set();
  });
  const [gitFilter, setGitFilter] = useState<Set<string>>(new Set());
  const [modeFilter, setModeFilter] = useState<Set<string>>(new Set());
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

  // Auto-focus search input on mount (e.g. when navigating via Ctrl+F)
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Content search: debounced server call to find threads matching by message content
  // Stores threadId → snippet so we can display matching text on cards
  const [contentMatches, setContentMatches] = useState<Map<string, string>>(new Map());
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Cache: key = "query|projectId|cs" → Map<threadId, snippet>
  const searchCacheRef = useRef<Map<string, Map<string, string>>>(new Map());

  useEffect(() => {
    // Clear previous timer
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    const q = search.trim();
    if (!q) {
      setContentMatches(new Map());
      return;
    }

    const cacheKey = `${q}|${projectFilter || ''}|${caseSensitive ? '1' : '0'}`;
    const cached = searchCacheRef.current.get(cacheKey);
    if (cached) {
      setContentMatches(cached);
      return;
    }

    // Debounce 300ms to avoid hammering the server on every keystroke
    searchTimerRef.current = setTimeout(() => {
      const pid = projectFilter || undefined;
      api.searchThreadContent(q, pid, caseSensitive).then((res) => {
        if (res.isOk()) {
          const map = new Map<string, string>();
          const { threadIds, snippets } = res.value;
          for (const id of threadIds) {
            map.set(id, snippets[id] || '');
          }
          searchCacheRef.current.set(cacheKey, map);
          // Evict old entries to prevent unbounded growth
          if (searchCacheRef.current.size > 50) {
            const firstKey = searchCacheRef.current.keys().next().value!;
            searchCacheRef.current.delete(firstKey);
          }
          setContentMatches(map);
        }
      });
    }, 300);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search, projectFilter, caseSensitive]);

  const projectInfoById = useMemo(() => {
    const map: Record<string, { name: string; color?: string }> = {};
    for (const p of projects) map[p.id] = { name: p.name, color: p.color };
    return map;
  }, [projects]);
  const projectNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of projects) map[p.id] = p.name;
    return map;
  }, [projects]);

  const storeThreads = useMemo(() => {
    const all = Object.values(threadsByProject).flat();
    if (projectFilter) {
      return all.filter((t) => t.projectId === projectFilter);
    }
    return all;
  }, [threadsByProject, projectFilter]);

  // Check if any relevant project has more threads on the server than loaded
  const hasMoreServerThreads = useMemo(() => {
    const relevantProjects = projectFilter ? [projectFilter] : projects.map((p) => p.id);
    return relevantProjects.some((pid) => {
      const loaded = (threadsByProject[pid] ?? []).length;
      const total = threadTotalByProject[pid] ?? 0;
      return loaded < total;
    });
  }, [threadsByProject, threadTotalByProject, projectFilter, projects]);

  const [loadingMore, setLoadingMore] = useState(false);
  const handleLoadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const relevantProjects = projectFilter ? [projectFilter] : projects.map((p) => p.id);
      await Promise.all(
        relevantProjects
          .filter((pid) => (threadsByProject[pid] ?? []).length < (threadTotalByProject[pid] ?? 0))
          .map((pid) => loadMoreThreads(pid)),
      );
    } finally {
      setLoadingMore(false);
    }
  }, [projectFilter, projects, threadsByProject, threadTotalByProject, loadMoreThreads]);

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
        const gs = statusByBranch[computeBranchKey(t)];
        return gs ? gitFilter.has(gs.state) : false;
      });
    }

    // Mode filter (multi-select)
    if (modeFilter.size > 0) {
      result = result.filter((t) => modeFilter.has(t.mode));
    }

    // Sort by selected field and direction
    result = [...result].sort((a, b) => {
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
    statusByBranch,
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
    setShowArchived(false);
    if (projectFilter) {
      setProjectFilter(null);
    }
    setSearchParams(buildSearchParams({ project: null }), { replace: true });
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
  };

  const hasActiveFilters =
    statusFilter.size > 0 ||
    gitFilter.size > 0 ||
    modeFilter.size > 0 ||
    showArchived ||
    !!projectFilter;

  if (!allThreadsProjectId) return null;

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
      const gs = statusByBranch[computeBranchKey(t)];
      if (gs) {
        counts[gs.state] = (counts[gs.state] || 0) + 1;
      }
    }
    return counts;
  }, [allThreads, statusByBranch]);

  const threadStatuses: ThreadStatus[] = [
    'running',
    'waiting',
    'completed',
    'failed',
    'stopped',
    'pending',
    'interrupted',
  ];
  const gitStates: GitSyncState[] = ['dirty', 'unpushed', 'pushed', 'merged', 'clean'];

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        {projectFilter && (
          <TooltipIconButton
            onClick={() => {
              navigate(buildPath(`/projects/${projectFilter}`));
            }}
            className="text-muted-foreground hover:text-foreground"
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
            {projectFilter && filteredProject ? t('allThreads.title') : t('allThreads.globalTitle')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {projectFilter && filteredProject
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
        onCaseSensitiveChange={setCaseSensitive}
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
        statusCounts={statusCounts}
        gitCounts={gitCounts}
        threadStatuses={threadStatuses}
        gitStates={gitStates}
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
