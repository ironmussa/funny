import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { ArchiveRestore, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThreadListView } from '@/components/ThreadListView';
import type { Thread } from '@a-parallel/shared';

const PAGE_SIZE_OPTIONS = [100, 250, 500, 1000] as const;
const DEFAULT_PAGE_SIZE = 100;

export function ArchivedThreadsSettings() {
  const { t } = useTranslation();
  const projects = useAppStore(s => s.projects);
  const loadThreadsForProject = useAppStore(s => s.loadThreadsForProject);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(DEFAULT_PAGE_SIZE);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const projectMap = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p])),
    [projects]
  );

  const fetchArchived = useCallback(async (p: number, l: number, s: string) => {
    setLoading(true);
    const result = await api.listArchivedThreads({ page: p, limit: l, search: s || undefined });
    if (result.isOk()) {
      setThreads(result.value.threads);
      setTotal(result.value.total);
    }
    // silently ignore errors
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchArchived(page, limit, debouncedSearch);
  }, [fetchArchived, page, limit, debouncedSearch]);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
    }, 300);
  };

  const handlePageSizeChange = (newLimit: number) => {
    setLimit(newLimit);
    setPage(1);
  };

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

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {total} {t('archived.archivedCount')}
        {debouncedSearch && ` ${t('allThreads.found')}`}
      </p>

      <ThreadListView
        threads={threads}
        totalCount={total}
        loading={loading}
        search={search}
        onSearchChange={handleSearchChange}
        searchPlaceholder={t('archived.searchPlaceholder')}
        page={page}
        onPageChange={setPage}
        pageSize={limit}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={handlePageSizeChange}
        emptyMessage={t('archived.noArchived')}
        searchEmptyMessage={t('allThreads.noMatch')}
        renderExtraBadges={(thread) => (
          <span className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded truncate max-w-[150px]">
            {projectMap[thread.projectId]?.name ?? '—'}
          </span>
        )}
        renderActions={(thread) => (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => handleUnarchive(thread)}
              title={t('archived.restore')}
              className="text-muted-foreground hover:text-foreground"
            >
              <ArchiveRestore className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => handleDelete(thread)}
              title={t('common.delete')}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        paginationLabel={({ from, to, total: totalCount }) =>
          t('archived.showingRange', {
            from,
            to,
            total: totalCount,
            defaultValue: '{{from}}-{{to}} of {{total}}',
          })
        }
      />
    </div>
  );
}
