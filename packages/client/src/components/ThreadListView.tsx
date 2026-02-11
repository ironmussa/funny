import { type ReactNode, useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { statusConfig, timeAgo, getStatusLabels } from '@/lib/thread-utils';
import { Search, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Thread, ThreadStatus } from '@a-parallel/shared';

interface ThreadListViewProps {
  threads: Thread[];
  totalCount: number;
  loading?: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  page: number;
  onPageChange: (page: number) => void;
  pageSize: number;
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (size: number) => void;
  emptyMessage: string;
  searchEmptyMessage: string;
  onThreadClick?: (thread: Thread) => void;
  renderExtraBadges?: (thread: Thread) => ReactNode;
  renderActions?: (thread: Thread) => ReactNode;
  paginationLabel: (info: { from: number; to: number; total: number }) => string;
  className?: string;
  autoFocusSearch?: boolean;
}

export function ThreadListView({
  threads,
  totalCount,
  loading,
  search,
  onSearchChange,
  searchPlaceholder,
  page,
  onPageChange,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  emptyMessage,
  searchEmptyMessage,
  onThreadClick,
  renderExtraBadges,
  renderActions,
  paginationLabel,
  className,
  autoFocusSearch,
}: ThreadListViewProps) {
  const { t } = useTranslation();
  const statusLabels = getStatusLabels(t);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reset highlight when threads or search change
  useEffect(() => {
    setHighlightIndex(-1);
  }, [search, threads]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!onThreadClick || threads.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(0);
      itemRefs.current[0]?.focus();
      itemRefs.current[0]?.scrollIntoView({ block: 'nearest' });
    }
  }, [threads, onThreadClick]);

  const handleItemKeyDown = useCallback((e: React.KeyboardEvent, i: number) => {
    if (!onThreadClick) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (i < threads.length - 1) {
        setHighlightIndex(i + 1);
        itemRefs.current[i + 1]?.focus();
        itemRefs.current[i + 1]?.scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (i > 0) {
        setHighlightIndex(i - 1);
        itemRefs.current[i - 1]?.focus();
        itemRefs.current[i - 1]?.scrollIntoView({ block: 'nearest' });
      } else {
        setHighlightIndex(-1);
        searchInputRef.current?.focus();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onThreadClick(threads[i]);
    }
  }, [threads, onThreadClick]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(page, totalPages);

  const from = (currentPage - 1) * pageSize + 1;
  const to = Math.min(currentPage * pageSize, totalCount);

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Search + optional page size */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            autoFocus={autoFocusSearch}
            className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-1.5 text-xs transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        {pageSizeOptions && onPageSizeChange && (
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size} / {t('archived.page', { defaultValue: 'page' })}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Thread list */}
      {loading ? (
        <div className="flex items-center justify-center h-32 text-muted-foreground text-xs flex-shrink-0">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          {t('common.loading')}
        </div>
      ) : threads.length === 0 ? (
        <div className="flex items-center justify-center h-32 text-muted-foreground text-xs flex-shrink-0">
          {search ? searchEmptyMessage : emptyMessage}
        </div>
      ) : (
        <div className="rounded-lg border border-border/50 overflow-y-auto min-h-0 flex-1">
          {threads.map((thread, i) => {
            const s = statusConfig[thread.status as ThreadStatus] ?? statusConfig.pending;
            const Icon = s.icon;
            const Wrapper = onThreadClick ? 'button' : 'div';

            return (
              <Wrapper
                key={thread.id}
                ref={(el: HTMLElement | null) => { itemRefs.current[i] = el; }}
                {...(onThreadClick ? { onClick: () => onThreadClick(thread) } : {})}
                onKeyDown={(e: React.KeyboardEvent) => handleItemKeyDown(e, i)}
                onFocus={() => setHighlightIndex(i)}
                onMouseEnter={() => { setHighlightIndex(i); itemRefs.current[i]?.focus(); }}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2.5 border-b border-border/50 last:border-b-0 group outline-none',
                  onThreadClick && 'text-left hover:bg-accent/50 transition-colors',
                  i === highlightIndex && 'bg-accent/50'
                )}
              >
                <Icon className={cn('h-4 w-4 flex-shrink-0', s.className)} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">{thread.title}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {renderExtraBadges?.(thread)}
                    {thread.branch && (
                      <span className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded truncate max-w-[150px]">
                        {thread.branch}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {statusLabels[thread.status as ThreadStatus]}
                    </span>
                  </div>
                </div>
                <span className="text-[10px] text-muted-foreground flex-shrink-0 hidden sm:inline">
                  {timeAgo(thread.createdAt, t)}
                </span>
                {renderActions?.(thread)}
              </Wrapper>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between flex-shrink-0">
          <span className="text-[11px] text-muted-foreground">
            {paginationLabel({ from, to, total: totalCount })}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="icon-xs"
              disabled={currentPage <= 1}
              onClick={() => onPageChange(currentPage - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="text-[11px] text-muted-foreground px-2">
              {currentPage} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="icon-xs"
              disabled={currentPage >= totalPages}
              onClick={() => onPageChange(currentPage + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
