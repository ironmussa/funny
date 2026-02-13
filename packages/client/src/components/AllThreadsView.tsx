import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { cn } from '@/lib/utils';
import { ChevronLeft, Archive, Search, ArrowUp, ArrowDown, LayoutList, Columns3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThreadListView } from '@/components/ThreadListView';
import { KanbanView } from '@/components/KanbanView';
import { statusConfig, gitSyncStateConfig, getStatusLabels } from '@/lib/thread-utils';
import { normalize } from '@/components/ui/highlight-text';
import type { Thread, ThreadStatus, GitSyncState } from '@a-parallel/shared';

const ITEMS_PER_PAGE = 20;

type FilterValue = 'all' | string;
type SortField = 'updated' | 'created';
type SortDir = 'desc' | 'asc';

function FilterChip({
  label,
  active,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-2 py-0.5 text-xs rounded-full border transition-colors whitespace-nowrap',
        active
          ? 'bg-accent text-accent-foreground border-accent-foreground/20'
          : 'bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground',
        className
      )}
    >
      {label}
    </button>
  );
}

export function AllThreadsView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const allThreadsProjectId = useAppStore(s => s.allThreadsProjectId);
  const threadsByProject = useAppStore(s => s.threadsByProject);
  const projects = useAppStore(s => s.projects);
  const statusByThread = useGitStatusStore(s => s.statusByThread);

  const isGlobalSearch = allThreadsProjectId === '__all__';

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<FilterValue>('all');
  const [gitFilter, setGitFilter] = useState<FilterValue>('all');
  const [modeFilter, setModeFilter] = useState<FilterValue>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [sortField, setSortField] = useState<SortField>('updated');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [viewMode, setViewMode] = useState<'list' | 'board'>(() => {
    const saved = localStorage.getItem('threadViewMode');
    return (saved === 'board' || saved === 'list') ? saved : 'list';
  });

  const project = isGlobalSearch ? null : projects.find((p) => p.id === allThreadsProjectId);
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
    if (isGlobalSearch) {
      // Aggregate threads from all projects
      return Object.values(threadsByProject).flat();
    }
    return allThreadsProjectId ? (threadsByProject[allThreadsProjectId] ?? []) : [];
  }, [isGlobalSearch, allThreadsProjectId, threadsByProject]);

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

    // Text search (accent-insensitive)
    if (search.trim()) {
      const q = normalize(search);
      result = result.filter(
        (t) =>
          normalize(t.title).includes(q) ||
          (t.branch && normalize(t.branch).includes(q)) ||
          normalize(t.status).includes(q) ||
          (isGlobalSearch && projectNameById[t.projectId] && normalize(projectNameById[t.projectId]).includes(q))
      );
    }

    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter((t) => t.status === statusFilter);
    }

    // Git status filter
    if (gitFilter !== 'all') {
      result = result.filter((t) => {
        const gs = statusByThread[t.id];
        return gs?.state === gitFilter;
      });
    }

    // Mode filter
    if (modeFilter !== 'all') {
      result = result.filter((t) => t.mode === modeFilter);
    }

    // Sort by selected field and direction
    result = [...result].sort((a, b) => {
      const dateA = sortField === 'updated'
        ? (a.completedAt ?? a.createdAt)
        : a.createdAt;
      const dateB = sortField === 'updated'
        ? (b.completedAt ?? b.createdAt)
        : b.createdAt;
      const diff = new Date(dateA).getTime() - new Date(dateB).getTime();
      return sortDir === 'desc' ? -diff : diff;
    });

    return result;
  }, [allThreads, search, statusFilter, gitFilter, modeFilter, statusByThread, isGlobalSearch, projectNameById, sortField, sortDir]);

  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE)));
  const paginated = filtered.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  const resetFilters = () => {
    setSearch('');
    setStatusFilter('all');
    setGitFilter('all');
    setModeFilter('all');
    setPage(1);
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const handleFilterChange = (setter: (v: FilterValue) => void) => (value: FilterValue) => {
    setter(value);
    setPage(1);
  };

  const hasActiveFilters = statusFilter !== 'all' || gitFilter !== 'all' || modeFilter !== 'all' || showArchived;

  if (!allThreadsProjectId || (!isGlobalSearch && !project)) return null;

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
      const gs = statusByThread[t.id];
      if (gs) {
        counts[gs.state] = (counts[gs.state] || 0) + 1;
      }
    }
    return counts;
  }, [allThreads, statusByThread]);

  const threadStatuses: ThreadStatus[] = ['running', 'waiting', 'completed', 'failed', 'stopped', 'pending', 'interrupted'];
  const gitStates: GitSyncState[] = ['dirty', 'unpushed', 'pushed', 'merged', 'clean'];

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => {
            if (isGlobalSearch) {
              navigate('/');
            } else {
              navigate(`/projects/${allThreadsProjectId}`);
            }
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          {isGlobalSearch ? <Search className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-medium">{isGlobalSearch ? t('allThreads.globalTitle') : t('allThreads.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {isGlobalSearch
              ? `${projects.length} ${t('allThreads.projects')} · ${allThreads.length} ${t('allThreads.threads')}`
              : `${project!.name} · ${allThreads.length} ${t('allThreads.threads')}`
            }
          </p>
        </div>

        <div className="flex items-center gap-2">
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              className="text-xs text-muted-foreground hover:text-foreground h-7"
            >
              {t('allThreads.clearFilters')}
            </Button>
          )}

          {/* View mode toggle */}
          <div className="flex items-center gap-1 bg-secondary/50 rounded-md p-0.5">
            <Button
              variant={viewMode === 'list' ? 'secondary' : 'ghost'}
              size="icon-xs"
              onClick={() => {
                setViewMode('list');
                localStorage.setItem('threadViewMode', 'list');
              }}
              className="h-6 w-6"
              title={t('kanban.listView')}
            >
              <LayoutList className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={viewMode === 'board' ? 'secondary' : 'ghost'}
              size="icon-xs"
              onClick={() => {
                setViewMode('board');
                localStorage.setItem('threadViewMode', 'board');
              }}
              className="h-6 w-6"
              title={t('kanban.boardView')}
            >
              <Columns3 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="px-4 py-2 border-b border-border/50 space-y-1.5">
        {/* Status row */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground uppercase tracking-wider w-12 flex-shrink-0">
            {t('allThreads.filterStatus')}
          </span>
          <FilterChip
            label={t('allThreads.filterAll')}
            active={statusFilter === 'all'}
            onClick={() => handleFilterChange(setStatusFilter)('all')}
          />
          {threadStatuses.map((s) => {
            const count = statusCounts[s] || 0;
            if (count === 0) return null;
            return (
              <FilterChip
                key={s}
                label={`${statusLabels[s]} (${count})`}
                active={statusFilter === s}
                onClick={() => handleFilterChange(setStatusFilter)(s)}
              />
            );
          })}
        </div>

        {/* Git status row */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground uppercase tracking-wider w-12 flex-shrink-0">
            Git
          </span>
          <FilterChip
            label={t('allThreads.filterAll')}
            active={gitFilter === 'all'}
            onClick={() => handleFilterChange(setGitFilter)('all')}
          />
          {gitStates.map((gs) => {
            const count = gitCounts[gs] || 0;
            if (count === 0) return null;
            return (
              <FilterChip
                key={gs}
                label={`${t(`gitStatus.${gs}`)} (${count})`}
                active={gitFilter === gs}
                onClick={() => handleFilterChange(setGitFilter)(gs)}
              />
            );
          })}
        </div>

        {/* Sort row */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground uppercase tracking-wider w-12 flex-shrink-0">
            {t('allThreads.sortLabel')}
          </span>
          <FilterChip
            label={t('allThreads.sortUpdated')}
            active={sortField === 'updated'}
            onClick={() => { setSortField('updated'); setPage(1); }}
          />
          <FilterChip
            label={t('allThreads.sortCreated')}
            active={sortField === 'created'}
            onClick={() => { setSortField('created'); setPage(1); }}
          />
          <div className="w-px h-4 bg-border mx-1" />
          <button
            onClick={() => { setSortDir(d => d === 'desc' ? 'asc' : 'desc'); setPage(1); }}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border transition-colors whitespace-nowrap',
              'bg-accent text-accent-foreground border-accent-foreground/20'
            )}
          >
            {sortDir === 'desc'
              ? <><ArrowDown className="h-3 w-3" />{t('allThreads.sortDesc')}</>
              : <><ArrowUp className="h-3 w-3" />{t('allThreads.sortAsc')}</>
            }
          </button>
        </div>

        {/* Mode + Archived row */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground uppercase tracking-wider w-12 flex-shrink-0">
            {t('allThreads.filterMode')}
          </span>
          <FilterChip
            label={t('allThreads.filterAll')}
            active={modeFilter === 'all'}
            onClick={() => handleFilterChange(setModeFilter)('all')}
          />
          <FilterChip
            label={t('thread.mode.local')}
            active={modeFilter === 'local'}
            onClick={() => handleFilterChange(setModeFilter)('local')}
          />
          <FilterChip
            label={t('thread.mode.worktree')}
            active={modeFilter === 'worktree'}
            onClick={() => handleFilterChange(setModeFilter)('worktree')}
          />
          <div className="w-px h-4 bg-border mx-1" />
          <FilterChip
            label={t('allThreads.showArchived')}
            active={showArchived}
            onClick={() => { setShowArchived(!showArchived); setPage(1); }}
            className={showArchived ? 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400' : ''}
          />
        </div>
      </div>

      {/* Search bar (shared between both views) */}
      <div className="px-4 pt-3 pb-2 flex-shrink-0 border-b border-border/50">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder={isGlobalSearch ? t('allThreads.globalSearchPlaceholder') : t('allThreads.searchPlaceholder')}
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            autoFocus
            className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-1.5 text-xs transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {/* Thread content */}
      <div className="flex-1 min-h-0 flex flex-col">
        {viewMode === 'board' ? (
          <div className="flex-1 min-h-0">
            <KanbanView threads={filtered} projectId={isGlobalSearch ? undefined : allThreadsProjectId} search={search} />
          </div>
        ) : (
          <div className="px-4 py-3 h-full">
            <ThreadListView
              className="h-full"
              autoFocusSearch={false}
              threads={paginated}
              totalCount={filtered.length}
              search={search}
              onSearchChange={handleSearchChange}
              searchPlaceholder={isGlobalSearch ? t('allThreads.globalSearchPlaceholder') : t('allThreads.searchPlaceholder')}
              page={currentPage}
              onPageChange={setPage}
              pageSize={ITEMS_PER_PAGE}
              emptyMessage={t('allThreads.noThreads')}
              searchEmptyMessage={t('allThreads.noMatch')}
              onThreadClick={(thread) => navigate(`/projects/${thread.projectId}/threads/${thread.id}`)}
              paginationLabel={({ total }) =>
                `${total} ${t('allThreads.threads')}${search || hasActiveFilters ? ` ${t('allThreads.found')}` : ''}`
              }
              hideSearch={true}
              renderExtraBadges={(thread) => {
            const gs = statusByThread[thread.id];
            const gitConf = gs ? gitSyncStateConfig[gs.state] : null;
            return (
              <>
                {isGlobalSearch && projectInfoById[thread.projectId] && (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{
                      backgroundColor: projectInfoById[thread.projectId].color ? `${projectInfoById[thread.projectId].color}1A` : '#3b82f61A',
                      color: projectInfoById[thread.projectId].color || '#3b82f6',
                    }}
                  >
                    {projectInfoById[thread.projectId].name}
                  </span>
                )}
                {!!thread.archived && (
                  <span className="inline-flex items-center gap-0.5 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                    <Archive className="h-2.5 w-2.5" />
                    {t('allThreads.archived')}
                  </span>
                )}
                {gitConf && (
                  <span className={cn('text-xs px-1.5 py-0.5 rounded bg-secondary', gitConf.className)}>
                    {t(gitConf.labelKey)}
                  </span>
                )}
                <span className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
                  {t(`thread.mode.${thread.mode}`)}
                </span>
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
