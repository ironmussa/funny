import type { ThreadStatus, GitSyncState } from '@funny/shared';
import {
  ChevronLeft,
  Archive,
  ArrowUp,
  ArrowDown,
  Columns3,
  ChevronDown,
  Check,
  Search,
  X,
} from 'lucide-react';
import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { KanbanView } from '@/components/KanbanView';
import { ThreadPowerline } from '@/components/ThreadPowerline';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { normalize } from '@/components/ui/highlight-text';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { colorFromName } from '@/components/ui/project-chip';
import { SearchBar } from '@/components/ui/search-bar';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { VirtualThreadList } from '@/components/VirtualThreadList';
import { api } from '@/lib/api';
import { getStatusLabels } from '@/lib/thread-utils';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useGitStatusStore, branchKey as computeBranchKey } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

type SortField = 'updated' | 'created';
type SortDir = 'desc' | 'asc';

function FilterDropdown({
  label,
  options,
  selected,
  onToggle,
  counts,
  testId,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  counts?: Record<string, number>;
  testId?: string;
}) {
  const activeCount = selected.size;
  const triggerLabel =
    activeCount === 0
      ? label
      : activeCount === 1
        ? (options.find((o) => selected.has(o.value))?.label ?? label)
        : `${label} (${activeCount})`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          data-testid={testId}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors whitespace-nowrap',
            activeCount > 0
              ? 'bg-accent text-accent-foreground border-accent-foreground/20'
              : 'bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground',
          )}
        >
          {triggerLabel}
          <ChevronDown className="icon-xs opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto min-w-[160px] p-1">
        {options.map((opt) => {
          const isActive = selected.has(opt.value);
          const count = counts?.[opt.value];
          return (
            <button
              key={opt.value}
              onClick={() => onToggle(opt.value)}
              className={cn(
                'flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm transition-colors text-left',
                'hover:bg-accent hover:text-accent-foreground',
                isActive && 'text-accent-foreground',
              )}
            >
              <span
                className={cn(
                  'flex h-3.5 w-3.5 items-center justify-center rounded-sm border',
                  isActive
                    ? 'bg-primary border-primary text-primary-foreground'
                    : 'border-muted-foreground/30',
                )}
              >
                {isActive && <Check className="icon-2xs" />}
              </span>
              <span className="flex-1">{opt.label}</span>
              {count != null && count > 0 && (
                <span className="tabular-nums text-muted-foreground">{count}</span>
              )}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

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

  const handleViewModeChange = (mode: 'list' | 'board') => {
    // Navigate to the appropriate route instead of using query params
    const params = buildSearchParams();
    const qs = new URLSearchParams(params).toString();
    const path = mode === 'board' ? '/kanban' : '/list';
    navigate(buildPath(qs ? `${path}?${qs}` : path), { replace: true });
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

  const statusLabels = getStatusLabels(t);

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

  const toggleFilter =
    (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (value: string) => {
      setter((prev) => {
        const next = new Set(prev);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
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

      {/* Filters */}
      <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2">
        {/* Search (compact, inline) */}
        <SearchBar
          inputRef={searchInputRef}
          query={search}
          onQueryChange={handleSearchChange}
          totalMatches={filtered.length}
          resultLabel={search.trim() ? `${filtered.length}/${allThreads.length}` : ''}
          caseSensitive={caseSensitive}
          onCaseSensitiveChange={setCaseSensitive}
          onInputKeyDown={(e) => searchKeyDownRef.current?.(e)}
          onClose={search ? () => handleSearchChange('') : undefined}
          autoFocus={false}
          placeholder={
            projectFilter
              ? t('allThreads.searchPlaceholder')
              : t('allThreads.globalSearchPlaceholder')
          }
          testIdPrefix="all-threads-search"
          className="h-7 w-72 flex-shrink-0 rounded-md border border-input bg-transparent px-2"
        />

        <div className="h-4 w-px bg-border" />

        {/* Project filter (single-select) */}
        <Popover open={projectFilterOpen} onOpenChange={setProjectFilterOpen}>
          <PopoverTrigger asChild>
            <button
              data-testid="all-threads-project-filter"
              className={cn(
                'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors whitespace-nowrap',
                projectFilter
                  ? 'bg-accent text-accent-foreground border-accent-foreground/20'
                  : 'bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground',
              )}
            >
              {projectFilter && filteredProject
                ? filteredProject.name
                : t('allThreads.filterProject')}
              <ChevronDown className="icon-xs opacity-50" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[240px] p-0">
            <Command>
              <CommandInput
                placeholder={t('kanban.searchProject')}
                className="h-9 text-xs"
                data-testid="all-threads-project-filter-search"
              />
              <CommandList>
                <CommandEmpty>{t('commandPalette.noResults')}</CommandEmpty>
                <CommandGroup>
                  <CommandItem
                    value={t('allThreads.allProjects')}
                    onSelect={() => {
                      handleProjectFilterChange(null);
                      setProjectFilterOpen(false);
                    }}
                    className="text-xs"
                  >
                    <span
                      className={cn(
                        'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                        !projectFilter
                          ? 'bg-primary border-primary text-primary-foreground'
                          : 'border-muted-foreground/30',
                      )}
                    >
                      {!projectFilter && <Check className="icon-2xs" />}
                    </span>
                    <span className="flex-1">{t('allThreads.allProjects')}</span>
                  </CommandItem>
                  {projects.map((p) => {
                    const isActive = projectFilter === p.id;
                    return (
                      <CommandItem
                        key={p.id}
                        value={`${p.name} ${p.path ?? ''}`}
                        onSelect={() => {
                          handleProjectFilterChange(p.id);
                          setProjectFilterOpen(false);
                        }}
                        className="text-xs"
                      >
                        <span
                          className={cn(
                            'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                            isActive
                              ? 'bg-primary border-primary text-primary-foreground'
                              : 'border-muted-foreground/30',
                          )}
                        >
                          {isActive && <Check className="icon-2xs" />}
                        </span>
                        <span className="flex-1 truncate">{p.name}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {/* Status dropdown */}
        <FilterDropdown
          testId="all-threads-status-filter"
          label={t('allThreads.filterStatus')}
          options={threadStatuses
            .filter((s) => (statusCounts[s] || 0) > 0)
            .map((s) => ({ value: s, label: statusLabels[s] }))}
          selected={statusFilter}
          onToggle={toggleFilter(setStatusFilter)}
          counts={statusCounts}
        />

        {/* Git dropdown */}
        <FilterDropdown
          testId="all-threads-git-filter"
          label="Git"
          options={gitStates
            .filter((gs) => (gitCounts[gs] || 0) > 0)
            .map((gs) => ({ value: gs, label: t(`gitStatus.${gs}`) }))}
          selected={gitFilter}
          onToggle={toggleFilter(setGitFilter)}
          counts={gitCounts}
        />

        {/* Mode dropdown */}
        <FilterDropdown
          label={t('allThreads.filterMode')}
          options={[
            { value: 'local', label: t('thread.mode.local') },
            { value: 'worktree', label: t('thread.mode.worktree') },
          ]}
          selected={modeFilter}
          onToggle={toggleFilter(setModeFilter)}
        />

        <div className="h-4 w-px bg-border" />

        {/* Sort toggle */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              data-testid="all-threads-sort"
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-border bg-transparent px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              {t('allThreads.sortLabel')}:{' '}
              {sortField === 'updated' ? t('allThreads.sortUpdated') : t('allThreads.sortCreated')}
              {sortDir === 'desc' ? (
                <ArrowDown className="icon-xs" />
              ) : (
                <ArrowUp className="icon-xs" />
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto min-w-[140px] p-1">
            <button
              onClick={() => {
                setSortField('updated');
              }}
              className={cn(
                'flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm transition-colors text-left',
                'hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <span
                className={cn(
                  'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                  sortField === 'updated'
                    ? 'bg-primary border-primary text-primary-foreground'
                    : 'border-muted-foreground/30',
                )}
              >
                {sortField === 'updated' && <Check className="icon-2xs" />}
              </span>
              {t('allThreads.sortUpdated')}
            </button>
            <button
              onClick={() => {
                setSortField('created');
              }}
              className={cn(
                'flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm transition-colors text-left',
                'hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <span
                className={cn(
                  'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                  sortField === 'created'
                    ? 'bg-primary border-primary text-primary-foreground'
                    : 'border-muted-foreground/30',
                )}
              >
                {sortField === 'created' && <Check className="icon-2xs" />}
              </span>
              {t('allThreads.sortCreated')}
            </button>
            <div className="my-1 h-px bg-border" />
            <button
              data-testid="all-threads-sort-direction"
              onClick={() => {
                setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {sortDir === 'desc' ? (
                <>
                  <ArrowDown className="icon-xs" />
                  {t('allThreads.sortDesc')}
                </>
              ) : (
                <>
                  <ArrowUp className="icon-xs" />
                  {t('allThreads.sortAsc')}
                </>
              )}
            </button>
          </PopoverContent>
        </Popover>

        {/* Archived toggle */}
        <button
          data-testid="all-threads-show-archived"
          onClick={() => {
            setShowArchived(!showArchived);
          }}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors whitespace-nowrap',
            showArchived
              ? 'bg-status-warning/10 border-status-warning/20 text-status-warning/80'
              : 'bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground',
          )}
        >
          <Archive className="icon-xs" />
          {t('allThreads.showArchived')}
        </button>

        {/* Clear filters */}
        {hasActiveFilters && (
          <button
            data-testid="all-threads-clear-filters"
            onClick={resetFilters}
            className="whitespace-nowrap px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('allThreads.clearFilters')}
          </button>
        )}
      </div>

      {/* Thread content */}
      <div className="flex min-h-0 flex-1 flex-col">
        {viewMode === 'board' ? (
          <div className="min-h-0 flex-1">
            <KanbanView
              threads={filtered}
              projectId={projectFilter || undefined}
              search={search}
              contentSnippets={contentMatches}
              highlightThreadId={searchParams.get('highlight') || undefined}
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
            <VirtualThreadList
              threads={filtered}
              search={search}
              contentSnippets={contentMatches}
              emptyMessage={t('allThreads.noThreads')}
              searchEmptyMessage={t('allThreads.noMatch')}
              hideBranch
              hasMore={hasMoreServerThreads}
              loadingMore={loadingMore}
              onEndReached={handleLoadMore}
              onSearchKeyDownRef={searchKeyDownRef}
              onThreadClick={(thread) => {
                // Ensure the project is expanded so the thread row mounts in
                // the sidebar before we try to scroll to it.
                const projectStore = useProjectStore.getState();
                if (!projectStore.expandedProjects.has(thread.projectId)) {
                  projectStore.toggleProject(thread.projectId);
                }

                // Full-priority commit so the center pane updates in parallel
                // with the sidebar's smooth scroll instead of after it.
                useUIStore.getState().setKanbanContext({
                  projectId: projectFilter || undefined,
                  search,
                  threadId: thread.id,
                  viewMode: 'list',
                });
                navigate(buildPath(`/projects/${thread.projectId}/threads/${thread.id}`));

                const scrollToThread = () => {
                  const el = document.querySelector(
                    `[data-project-id="${thread.projectId}"] [data-testid="thread-item-${thread.id}"]`,
                  );
                  if (el) {
                    el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
                    return true;
                  }
                  return false;
                };
                requestAnimationFrame(() => {
                  if (scrollToThread()) return;
                  // Collapsible slide-down hasn't mounted the row yet — retry after it settles.
                  setTimeout(scrollToThread, 300);
                });
              }}
              renderExtraBadges={(thread) => {
                const gs = statusByBranch[computeBranchKey(thread)];
                const pInfo = projectInfoById[thread.projectId];
                return (
                  <>
                    <ThreadPowerline
                      thread={thread}
                      projectName={!projectFilter ? pInfo?.name : undefined}
                      projectColor={pInfo?.color}
                      gitStatus={gs}
                      diffStatsSize="xxs"
                      data-testid={`list-thread-powerline-${thread.id}`}
                    />
                    {!!thread.archived && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1 py-px text-[10px] font-medium leading-tight text-status-warning/80">
                        <Archive className="icon-2xs" />
                        {t('allThreads.archived')}
                      </span>
                    )}
                  </>
                );
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
