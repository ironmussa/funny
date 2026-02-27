import type { Thread, ThreadStatus } from '@funny/shared';
import { Search, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { type ReactNode, useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { HighlightText, normalize } from '@/components/ui/highlight-text';
import { Input } from '@/components/ui/input';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { statusConfig, timeAgo, getStatusLabels } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

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
  hideSearch?: boolean;
  contentSnippets?: Map<string, string>;
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
  hideSearch = false,
  contentSnippets,
}: ThreadListViewProps) {
  const { t } = useTranslation();
  useMinuteTick();
  const statusLabels = getStatusLabels(t);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reset highlight when threads or search change
  useEffect(() => {
    setHighlightIndex(-1);
  }, [search, threads]);

  // Track whether navigation is keyboard-driven (focus follows highlight)
  // vs mouse-driven (highlight follows mouse but focus stays in search input)
  const keyboardNav = useRef(false);

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!onThreadClick || threads.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        keyboardNav.current = true;
        const next = highlightIndex < threads.length - 1 ? highlightIndex + 1 : 0;
        setHighlightIndex(next);
        itemRefs.current[next]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        keyboardNav.current = true;
        const prev = highlightIndex > 0 ? highlightIndex - 1 : threads.length - 1;
        setHighlightIndex(prev);
        itemRefs.current[prev]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && highlightIndex >= 0 && highlightIndex < threads.length) {
        e.preventDefault();
        onThreadClick(threads[highlightIndex]);
      }
    },
    [threads, onThreadClick, highlightIndex],
  );

  const handleItemKeyDown = useCallback(
    (e: React.KeyboardEvent, i: number) => {
      if (!onThreadClick) return;
      keyboardNav.current = true;
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
    },
    [threads, onThreadClick],
  );

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(page, totalPages);

  const from = (currentPage - 1) * pageSize + 1;
  const to = Math.min(currentPage * pageSize, totalCount);

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Search + optional page size */}
      {!hideSearch && (
        <div className="flex flex-shrink-0 items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder={searchPlaceholder}
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              autoFocus={autoFocusSearch}
              className="h-auto w-full py-1.5 pl-8 pr-3 text-xs"
            />
          </div>
          {pageSizeOptions && onPageSizeChange && (
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="cursor-pointer rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size} / {t('archived.page', { defaultValue: 'page' })}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Thread list */}
      {loading ? (
        <div className="flex h-32 flex-shrink-0 items-center justify-center text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t('common.loading')}
        </div>
      ) : threads.length === 0 ? (
        <div className="flex h-32 flex-shrink-0 items-center justify-center text-xs text-muted-foreground">
          {search ? searchEmptyMessage : emptyMessage}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/50">
          {threads.map((thread, i) => {
            const s = statusConfig[thread.status as ThreadStatus] ?? statusConfig.pending;
            const Icon = s.icon;
            const Wrapper = onThreadClick ? 'button' : 'div';

            return (
              <Wrapper
                key={thread.id}
                ref={(el: HTMLElement | null) => {
                  itemRefs.current[i] = el;
                }}
                {...(onThreadClick ? { onClick: () => onThreadClick(thread) } : {})}
                onKeyDown={(e: React.KeyboardEvent) => handleItemKeyDown(e, i)}
                onFocus={() => setHighlightIndex(i)}
                onMouseMove={() => {
                  keyboardNav.current = false;
                  setHighlightIndex(i);
                }}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2.5 border-b border-border/50 last:border-b-0 group outline-none',
                  onThreadClick && 'text-left hover:bg-accent/50 transition-colors',
                  i === highlightIndex && 'bg-accent/50',
                )}
              >
                <Icon className={cn('h-4 w-4 flex-shrink-0', s.className)} />
                <div className="min-w-0 flex-1">
                  <HighlightText
                    text={thread.title}
                    query={search}
                    className="block truncate text-xs font-medium"
                  />
                  {contentSnippets?.get(thread.id) && search && !normalize(thread.title).includes(normalize(search)) && (
                    <HighlightText
                      text={contentSnippets.get(thread.id)!}
                      query={search}
                      className="block truncate text-[11px] italic text-muted-foreground"
                    />
                  )}
                  <div className="mt-0.5 flex items-center gap-2">
                    {renderExtraBadges?.(thread)}
                    {(thread.branch || thread.baseBranch) && (
                      <span className="max-w-[150px] truncate rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                        {thread.branch || thread.baseBranch}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {statusLabels[thread.status as ThreadStatus]}
                    </span>
                  </div>
                </div>
                <span className="hidden flex-shrink-0 text-xs text-muted-foreground sm:inline">
                  {timeAgo(thread.completedAt ?? thread.createdAt, t)}
                </span>
                {renderActions?.(thread)}
              </Wrapper>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex flex-shrink-0 items-center justify-between">
          <span className="text-sm text-muted-foreground">
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
            <span className="px-2 text-sm text-muted-foreground">
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
