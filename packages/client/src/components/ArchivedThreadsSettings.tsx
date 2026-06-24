import type { GitStatusInfo, Thread } from '@funny/shared';
import { ArchiveRestore, Trash2 } from 'lucide-react';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ThreadPowerline } from '@/components/ThreadPowerline';
import { LoadingState } from '@/components/ui/loading-state';
import { SearchBar } from '@/components/ui/search-bar';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { VirtualThreadList } from '@/components/VirtualThreadList';
import { api } from '@/lib/api';
import { useAppStore } from '@/stores/app-store';
import { statusBranchKeyForThread, useGitStatusStore } from '@/stores/git-status-store';

const PAGE_SIZE = 100;

export function ArchivedThreadsSettings() {
  const { t } = useTranslation();
  const projects = useAppStore((s) => s.projects);
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const loadThreadsForProject = useAppStore((s) => s.loadThreadsForProject);
  const statusByBranch = useGitStatusStore((s) => s.statusByBranch);
  const threadToBranchKey = useGitStatusStore((s) => s.threadToBranchKey);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const projectMap = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects]);

  // Fetch one page. page 1 replaces the list (initial load / new search);
  // later pages append for infinite scroll.
  const fetchArchived = useCallback(
    async (p: number, s: string) => {
      if (p === 1) setLoading(true);
      else setLoadingMore(true);
      const result = await api.listArchivedThreads({
        page: p,
        limit: PAGE_SIZE,
        search: s || undefined,
        projectId: selectedProjectId || undefined,
      });
      if (result.isOk()) {
        setTotal(result.value.total);
        setThreads((prev) => (p === 1 ? result.value.threads : [...prev, ...result.value.threads]));
      }
      // silently ignore errors
      setLoading(false);
      setLoadingMore(false);
    },
    [selectedProjectId],
  );

  // Reset to page 1 and refetch whenever the debounced query changes.
  useEffect(() => {
    setPage(1);
    fetchArchived(1, debouncedSearch);
  }, [fetchArchived, debouncedSearch]);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(value), 300);
  };

  const handleLoadMore = useCallback(() => {
    if (loading || loadingMore || threads.length >= total) return;
    const next = page + 1;
    setPage(next);
    fetchArchived(next, debouncedSearch);
  }, [loading, loadingMore, threads.length, total, page, fetchArchived, debouncedSearch]);

  const handleUnarchive = async (thread: Thread) => {
    const result = await api.archiveThread(thread.id, false);
    if (result.isOk()) {
      setThreads((prev) => prev.filter((t) => t.id !== thread.id));
      setTotal((prev) => prev - 1);
      loadThreadsForProject(thread.projectId);
      toast.success(t('archived.restored', { title: thread.title }));
    } else {
      toast.error(t('archived.restoreFailed'));
    }
  };

  const handleDelete = async (thread: Thread) => {
    if (!confirm(t('dialog.deleteThreadDesc', { title: thread.title }))) return;
    const result = await api.deleteThread(thread.id);
    if (result.isOk()) {
      setThreads((prev) => prev.filter((t) => t.id !== thread.id));
      setTotal((prev) => prev - 1);
      toast.success(t('toast.threadDeleted', { title: thread.title }));
    }
    // silently ignore errors
  };

  const hasMore = threads.length < total;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Toolbar — mirrors the /list search bar */}
      <div className="border-border/50 flex items-center gap-2 border-b px-4 py-2">
        <SearchBar
          inputRef={searchInputRef}
          query={search}
          onQueryChange={handleSearchChange}
          totalMatches={threads.length}
          resultLabel={search.trim() ? `${threads.length}/${total}` : ''}
          onClose={search ? () => handleSearchChange('') : undefined}
          autoFocus
          placeholder={t('archived.searchPlaceholder')}
          testIdPrefix="archived-search"
          className="border-input h-7 w-72 shrink-0 rounded-md border bg-transparent px-2"
        />
        <div className="bg-border h-4 w-px" />
        <span className="text-muted-foreground text-xs">
          {total} {t('archived.archivedCount')}
        </span>
      </div>

      {/* List — full-width rows + infinite scroll, same as /list */}
      <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
        {loading ? (
          <LoadingState
            fill={false}
            layout="inline"
            size="compact"
            className="h-32 shrink-0"
            testId="archived-loading"
            label={t('common.loading')}
          />
        ) : (
          <VirtualThreadList
            threads={threads}
            search={debouncedSearch}
            emptyMessage={t('archived.noArchived')}
            searchEmptyMessage={t('allThreads.noMatch')}
            hideBranch
            hasMore={hasMore}
            loadingMore={loadingMore}
            onEndReached={handleLoadMore}
            renderExtraBadges={(thread) => {
              const gs: GitStatusInfo | undefined =
                statusByBranch[statusBranchKeyForThread(thread, threadToBranchKey)];
              const project = projectMap[thread.projectId];
              return (
                <ThreadPowerline
                  thread={thread}
                  projectName={project?.name}
                  projectColor={project?.color}
                  gitStatus={gs}
                  diffStatsSize="xxs"
                  data-testid={`archived-thread-powerline-${thread.id}`}
                />
              );
            }}
            renderActions={(thread) => (
              <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/row:opacity-100">
                <TooltipIconButton
                  onClick={() => handleUnarchive(thread)}
                  className="text-muted-foreground hover:text-foreground"
                  tooltip={t('archived.restore')}
                >
                  <ArchiveRestore className="icon-sm" />
                </TooltipIconButton>
                <TooltipIconButton
                  onClick={() => handleDelete(thread)}
                  className="text-muted-foreground hover:text-destructive"
                  tooltip={t('common.delete')}
                >
                  <Trash2 className="icon-sm" />
                </TooltipIconButton>
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
}
