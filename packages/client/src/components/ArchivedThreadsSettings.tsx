import type { GitStatusInfo, Thread } from '@funny/shared';
import { ArchiveRestore, Trash2 } from 'lucide-react';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { ThreadPowerline } from '@/components/ThreadPowerline';
import { LoadingState } from '@/components/ui/loading-state';
import { SearchBar } from '@/components/ui/search-bar';
import { toast } from '@/components/ui/toast';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { VirtualThreadList } from '@/components/VirtualThreadList';
import { useGitStatusMaps } from '@/data/git-status/hooks';
import { statusBranchKeyForThread } from '@/data/git-status/keys';
import { useProjects } from '@/data/projects/hooks';
import { api } from '@/lib/api';
import { withCleanup } from '@/lib/while-pending';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

const PAGE_SIZE = 100;

const archivedKey = (projectId: string | null, search: string) => `${projectId ?? ''}|${search}`;

export function ArchivedThreadsSettings() {
  const { t } = useTranslation();
  const projects = useProjects();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const loadThreadsForProject = useThreadStore((s) => s.loadThreadsForProject);
  const { statusByBranch, threadToBranchKey } = useGitStatusMaps();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [total, setTotal] = useState(0);
  // The project + query of the last first-page fetch that settled. The first
  // page is loading whenever the current ones have not settled yet.
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const pageRef = useRef(1);
  // Bumped by every first-page fetch, so only the latest one settles the list.
  const firstPageSeqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const projectMap = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects]);

  // Fetch one page. page 1 replaces the list (initial load / new search);
  // later pages append for infinite scroll (the caller sets `loadingMore`).
  const fetchArchived = useCallback(
    async (p: number, s: string) => {
      const seq = p === 1 ? ++firstPageSeqRef.current : firstPageSeqRef.current;
      // A first page superseded by a newer project or query is ignored.
      const isStale = () => p === 1 && seq !== firstPageSeqRef.current;
      return withCleanup(
        async () => {
          const result = await api.listArchivedThreads({
            page: p,
            limit: PAGE_SIZE,
            search: s || undefined,
            projectId: selectedProjectId || undefined,
          });
          if (result.isOk() && !isStale()) {
            setTotal(result.value.total);
            setThreads((prev) =>
              p === 1 ? result.value.threads : [...prev, ...result.value.threads],
            );
          }
          // silently ignore errors
        },
        () => {
          if (p === 1 && !isStale()) setSettledKey(archivedKey(selectedProjectId, s));
          setLoadingMore(false);
        },
      );
    },
    [selectedProjectId],
  );

  const loading = settledKey !== archivedKey(selectedProjectId, debouncedSearch);

  // Reset to page 1 and refetch whenever the debounced query changes.
  useEffect(() => {
    pageRef.current = 1;
    fetchArchived(1, debouncedSearch);
  }, [fetchArchived, debouncedSearch]);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(value), 300);
  };

  const handleLoadMore = useCallback(() => {
    if (loading || loadingMore || threads.length >= total) return;
    const next = pageRef.current + 1;
    pageRef.current = next;
    setLoadingMore(true);
    fetchArchived(next, debouncedSearch);
  }, [loading, loadingMore, threads.length, total, fetchArchived, debouncedSearch]);

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
          variant="outline"
          className="h-7 w-72 shrink-0"
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
                  variant="muted"
                  onClick={() => handleUnarchive(thread)}

                  tooltip={t('archived.restore')}
                >
                  <ArchiveRestore className="icon-sm" />
                </TooltipIconButton>
                <TooltipIconButton
                  variant="muted-destructive"
                  onClick={() => handleDelete(thread)}

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
