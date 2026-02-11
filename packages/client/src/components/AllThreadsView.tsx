import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ChevronLeft, Archive, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThreadListView } from '@/components/ThreadListView';
import { statusConfig, gitSyncStateConfig, getStatusLabels } from '@/lib/thread-utils';
import type { Thread, ThreadStatus, GitSyncState } from '@a-parallel/shared';

const ITEMS_PER_PAGE = 20;

type FilterValue = 'all' | string;

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
        'px-2 py-0.5 text-[11px] rounded-full border transition-colors whitespace-nowrap',
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
  const [archivedThreads, setArchivedThreads] = useState<Thread[]>([]);

  const project = isGlobalSearch ? null : projects.find((p) => p.id === allThreadsProjectId);
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

  // Fetch archived threads when toggled on
  useEffect(() => {
    if (!showArchived || !allThreadsProjectId) {
      setArchivedThreads([]);
      return;
    }
    if (isGlobalSearch) {
      // Fetch archived threads for all projects
      Promise.all(projects.map(async (p) => {
        const result = await api.listThreads(p.id, true);
        return result.isOk() ? result.value : [] as Thread[];
      }))
        .then((results) => {
          setArchivedThreads(results.flat().filter((t) => t.archived));
        });
    } else {
      (async () => {
        const result = await api.listThreads(allThreadsProjectId, true);
        if (result.isOk()) {
          setArchivedThreads(result.value.filter((t) => t.archived));
        }
      })();
    }
  }, [showArchived, allThreadsProjectId, isGlobalSearch, projects]);

  const allThreads = useMemo(() => {
    if (!showArchived) return storeThreads;
    // Merge: store threads + archived threads (avoid duplicates)
    const ids = new Set(storeThreads.map((t) => t.id));
    return [...storeThreads, ...archivedThreads.filter((t) => !ids.has(t.id))];
  }, [storeThreads, archivedThreads, showArchived]);

  const statusLabels = getStatusLabels(t);

  const filtered = useMemo(() => {
    let result = allThreads;

    // Text search
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.branch && t.branch.toLowerCase().includes(q)) ||
          t.status.toLowerCase().includes(q) ||
          (isGlobalSearch && projectNameById[t.projectId]?.toLowerCase().includes(q))
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

    return result;
  }, [allThreads, search, statusFilter, gitFilter, modeFilter, statusByThread, isGlobalSearch, projectNameById]);

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
            useAppStore.getState().closeAllThreads();
            if (!isGlobalSearch) navigate(`/projects/${allThreadsProjectId}`);
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
        <span className="text-[10px] text-muted-foreground hidden sm:block">Ctrl+Shift+F</span>
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
      </div>

      {/* Filters */}
      <div className="px-4 py-2 border-b border-border/50 space-y-1.5">
        {/* Status row */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider w-12 flex-shrink-0">
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
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider w-12 flex-shrink-0">
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

        {/* Mode + Archived row */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider w-12 flex-shrink-0">
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

      {/* Thread list */}
      <div className="flex-1 min-h-0 px-4 py-3">
        <ThreadListView
          className="h-full"
          autoFocusSearch
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
          renderExtraBadges={(thread) => {
            const gs = statusByThread[thread.id];
            const gitConf = gs ? gitSyncStateConfig[gs.state] : null;
            return (
              <>
                {isGlobalSearch && projectNameById[thread.projectId] && (
                  <span className="text-[10px] text-blue-500 dark:text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded">
                    {projectNameById[thread.projectId]}
                  </span>
                )}
                {thread.archived && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                    <Archive className="h-2.5 w-2.5" />
                    {t('allThreads.archived')}
                  </span>
                )}
                {gitConf && (
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded bg-secondary', gitConf.className)}>
                    {t(gitConf.labelKey)}
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
                  {t(`thread.mode.${thread.mode}`)}
                </span>
              </>
            );
          }}
        />
      </div>
    </div>
  );
}
