import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { cn } from '@/lib/utils';
import { ChevronLeft, Archive, Search, ArrowUp, ArrowDown, LayoutList, Columns3, ChevronDown, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { ThreadListView } from '@/components/ThreadListView';
import { KanbanView } from '@/components/KanbanView';
import { statusConfig, gitSyncStateConfig, getStatusLabels } from '@/lib/thread-utils';
import { normalize } from '@/components/ui/highlight-text';
import { api } from '@/lib/api';
import type { Thread, ThreadStatus, GitSyncState } from '@a-parallel/shared';

const ITEMS_PER_PAGE = 20;

type SortField = 'updated' | 'created';
type SortDir = 'desc' | 'asc';

function FilterDropdown({
  label,
  options,
  selected,
  onToggle,
  counts,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  counts?: Record<string, number>;
}) {
  const activeCount = selected.size;
  const triggerLabel = activeCount === 0
    ? label
    : activeCount === 1
      ? options.find(o => selected.has(o.value))?.label ?? label
      : `${label} (${activeCount})`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors whitespace-nowrap',
            activeCount > 0
              ? 'bg-accent text-accent-foreground border-accent-foreground/20'
              : 'bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground'
          )}
        >
          {triggerLabel}
          <ChevronDown className="h-3 w-3 opacity-50" />
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
                isActive && 'text-accent-foreground'
              )}
            >
              <span className={cn(
                'flex h-3.5 w-3.5 items-center justify-center rounded-sm border',
                isActive ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/30'
              )}>
                {isActive && <Check className="h-2.5 w-2.5" />}
              </span>
              <span className="flex-1">{opt.label}</span>
              {count != null && count > 0 && (
                <span className="text-muted-foreground tabular-nums">{count}</span>
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
  const allThreadsProjectId = useAppStore(s => s.allThreadsProjectId);
  const threadsByProject = useAppStore(s => s.threadsByProject);
  const projects = useAppStore(s => s.projects);
  const statusByThread = useGitStatusStore(s => s.statusByThread);

  const isGlobalSearch = allThreadsProjectId === '__all__';

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [gitFilter, setGitFilter] = useState<Set<string>>(new Set());
  const [modeFilter, setModeFilter] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [sortField, setSortField] = useState<SortField>('updated');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [viewMode, setViewMode] = useState<'list' | 'board'>(() => {
    const saved = localStorage.getItem('threadViewMode');
    return (saved === 'board' || saved === 'list') ? saved : 'list';
  });

  // Content search: debounced server call to find threads matching by message content
  // Stores threadId → snippet so we can display matching text on cards
  const [contentMatches, setContentMatches] = useState<Map<string, string>>(new Map());
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    // Clear previous timer
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    const q = search.trim();
    if (!q) {
      setContentMatches(new Map());
      return;
    }

    // Debounce 300ms to avoid hammering the server on every keystroke
    searchTimerRef.current = setTimeout(() => {
      const projectId = isGlobalSearch ? undefined : (allThreadsProjectId || undefined);
      api.searchThreadContent(q, projectId).then((res) => {
        if (res.isOk()) {
          const map = new Map<string, string>();
          const { threadIds, snippets } = res.value;
          for (const id of threadIds) {
            map.set(id, snippets[id] || '');
          }
          setContentMatches(map);
        }
      });
    }, 300);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search, isGlobalSearch, allThreadsProjectId]);

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

    // Text search (accent-insensitive) — matches title, branch, status, project name, OR message content
    if (search.trim()) {
      const q = normalize(search);
      result = result.filter(
        (t) =>
          normalize(t.title).includes(q) ||
          (t.branch && normalize(t.branch).includes(q)) ||
          normalize(t.status).includes(q) ||
          (isGlobalSearch && projectNameById[t.projectId] && normalize(projectNameById[t.projectId]).includes(q)) ||
          contentMatches.has(t.id)
      );
    }

    // Status filter (multi-select)
    if (statusFilter.size > 0) {
      result = result.filter((t) => statusFilter.has(t.status));
    }

    // Git status filter (multi-select)
    if (gitFilter.size > 0) {
      result = result.filter((t) => {
        const gs = statusByThread[t.id];
        return gs ? gitFilter.has(gs.state) : false;
      });
    }

    // Mode filter (multi-select)
    if (modeFilter.size > 0) {
      result = result.filter((t) => modeFilter.has(t.mode));
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
  }, [allThreads, search, statusFilter, gitFilter, modeFilter, statusByThread, isGlobalSearch, projectNameById, sortField, sortDir, contentMatches]);

  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE)));
  const paginated = filtered.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  const resetFilters = () => {
    setSearch('');
    setStatusFilter(new Set());
    setGitFilter(new Set());
    setModeFilter(new Set());
    setShowArchived(false);
    setPage(1);
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const toggleFilter = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (value: string) => {
    setter(prev => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
    setPage(1);
  };

  const hasActiveFilters = statusFilter.size > 0 || gitFilter.size > 0 || modeFilter.size > 0 || showArchived;

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
      <div className="px-4 py-2 border-b border-border/50 flex items-center gap-2">
        {/* Search input (compact, inline) */}
        <div className="relative flex-shrink-0">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            type="text"
            placeholder={isGlobalSearch ? t('allThreads.globalSearchPlaceholder') : t('allThreads.searchPlaceholder')}
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-44 h-auto pl-6 pr-2 py-1 text-xs"
          />
        </div>

        <div className="w-px h-4 bg-border" />

        {/* Status dropdown */}
        <FilterDropdown
          label={t('allThreads.filterStatus')}
          options={threadStatuses
            .filter(s => (statusCounts[s] || 0) > 0)
            .map(s => ({ value: s, label: statusLabels[s] }))}
          selected={statusFilter}
          onToggle={toggleFilter(setStatusFilter)}
          counts={statusCounts}
        />

        {/* Git dropdown */}
        <FilterDropdown
          label="Git"
          options={gitStates
            .filter(gs => (gitCounts[gs] || 0) > 0)
            .map(gs => ({ value: gs, label: t(`gitStatus.${gs}`) }))}
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

        <div className="w-px h-4 bg-border" />

        {/* Sort toggle */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground transition-colors whitespace-nowrap"
            >
              {t('allThreads.sortLabel')}: {sortField === 'updated' ? t('allThreads.sortUpdated') : t('allThreads.sortCreated')}
              {sortDir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto min-w-[140px] p-1">
            <button
              onClick={() => { setSortField('updated'); setPage(1); }}
              className={cn(
                'flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm transition-colors text-left',
                'hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <span className={cn(
                'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                sortField === 'updated' ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/30'
              )}>
                {sortField === 'updated' && <Check className="h-2.5 w-2.5" />}
              </span>
              {t('allThreads.sortUpdated')}
            </button>
            <button
              onClick={() => { setSortField('created'); setPage(1); }}
              className={cn(
                'flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm transition-colors text-left',
                'hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <span className={cn(
                'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                sortField === 'created' ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/30'
              )}>
                {sortField === 'created' && <Check className="h-2.5 w-2.5" />}
              </span>
              {t('allThreads.sortCreated')}
            </button>
            <div className="h-px bg-border my-1" />
            <button
              onClick={() => { setSortDir(d => d === 'desc' ? 'asc' : 'desc'); setPage(1); }}
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm transition-colors text-left hover:bg-accent hover:text-accent-foreground"
            >
              {sortDir === 'desc'
                ? <><ArrowDown className="h-3 w-3" />{t('allThreads.sortDesc')}</>
                : <><ArrowUp className="h-3 w-3" />{t('allThreads.sortAsc')}</>
              }
            </button>
          </PopoverContent>
        </Popover>

        {/* Archived toggle */}
        <button
          onClick={() => { setShowArchived(!showArchived); setPage(1); }}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors whitespace-nowrap',
            showArchived
              ? 'bg-status-warning/10 border-status-warning/20 text-status-warning/80'
              : 'bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground'
          )}
        >
          <Archive className="h-3 w-3" />
          {t('allThreads.showArchived')}
        </button>

        {/* Clear filters */}
        {hasActiveFilters && (
          <button
            onClick={resetFilters}
            className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
          >
            {t('allThreads.clearFilters')}
          </button>
        )}

      </div>

      {/* Thread content */}
      <div className="flex-1 min-h-0 flex flex-col">
        {viewMode === 'board' ? (
          <div className="flex-1 min-h-0">
            <KanbanView threads={filtered} projectId={isGlobalSearch ? undefined : allThreadsProjectId} search={search} contentSnippets={contentMatches} />
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
                  <span className="inline-flex items-center gap-0.5 text-xs text-status-warning/80 bg-status-warning/10 px-1.5 py-0.5 rounded">
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
