import type { Thread, ThreadStatus } from '@funny/shared';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { type ReactNode, useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { BranchBadge } from '@/components/BranchBadge';
import { HighlightText, normalize } from '@/components/ui/highlight-text';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { statusConfig, timeAgo, getStatusLabels } from '@/lib/thread-utils';
import { cn, resolveThreadBranch } from '@/lib/utils';

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
  hideBranch?: boolean;
  contentSnippets?: Map<string, string>;
  /** Expose the search keyboard handler so external inputs can drive arrow navigation */
  onSearchKeyDownRef?: React.MutableRefObject<((e: React.KeyboardEvent) => void) | null>;
  /** Current case-sensitive state. Pass `onCaseSensitiveChange` to enable the toggle. */
  caseSensitive?: boolean;
  /** Called when the user toggles case sensitivity. */
  onCaseSensitiveChange?: (value: boolean) => void;
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
  hideBranch = false,
  contentSnippets,
  onSearchKeyDownRef,
  caseSensitive,
  onCaseSensitiveChange,
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

  // Expose the search keyboard handler to parent components
  useEffect(() => {
    if (onSearchKeyDownRef) {
      onSearchKeyDownRef.current = handleSearchKeyDown;
    }
    return () => {
      if (onSearchKeyDownRef) {
        onSearchKeyDownRef.current = null;
      }
    };
  }, [onSearchKeyDownRef, handleSearchKeyDown]);

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
          <SearchBar
            inputRef={searchInputRef}
            query={search}
            onQueryChange={onSearchChange}
            placeholder={searchPlaceholder}
            totalMatches={threads.length}
            resultLabel={search.trim() ? `${threads.length}/${totalCount}` : ''}
            caseSensitive={caseSensitive}
            onCaseSensitiveChange={onCaseSensitiveChange}
            onInputKeyDown={handleSearchKeyDown}
            autoFocus={!!autoFocusSearch}
            testIdPrefix="thread-list-search"
            className="flex-1 rounded-md border border-input bg-background px-2"
          />
          {pageSizeOptions && onPageSizeChange && (
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="cursor-pointer rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
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
          <Loader2 className="icon-base mr-2 animate-spin" />
          {t('common.loading')}
        </div>
      ) : threads.length === 0 ? (
        <div className="flex h-32 flex-shrink-0 items-center justify-center text-xs text-muted-foreground">
          {search ? searchEmptyMessage : emptyMessage}
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border/50">
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
                <Icon className={cn('icon-base flex-shrink-0', s.className)} />
                <div className="min-w-0 flex-1">
                  <HighlightText
                    text={thread.title}
                    query={search}
                    className="block truncate text-sm font-medium"
                  />
                  {contentSnippets?.get(thread.id) &&
                    search &&
                    !normalize(thread.title).includes(normalize(search)) && (
                      <HighlightText
                        text={contentSnippets.get(thread.id)!}
                        query={search}
                        className="block truncate text-[11px] italic text-muted-foreground"
                      />
                    )}
                  <div className="mt-0.5 flex items-center gap-2">
                    {renderExtraBadges?.(thread)}
                    {!hideBranch && (resolveThreadBranch(thread) || thread.baseBranch) && (
                      <BranchBadge
                        branch={(resolveThreadBranch(thread) || thread.baseBranch)!}
                        size="xs"
                        className="max-w-[150px]"
                      />
                    )}
                  </div>
                </div>
                <span className="hidden flex-shrink-0 text-xs text-muted-foreground sm:inline">
                  {timeAgo(thread.completedAt ?? thread.createdAt, t)}
                </span>
                {renderActions?.(thread)}
              </Wrapper>
            );
          })}
        </ScrollArea>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex flex-shrink-0 items-center justify-between">
          <span className="text-sm text-muted-foreground">
            {paginationLabel({ from, to, total: totalCount })}
          </span>
          <div className="flex items-center gap-1.5">
            <TooltipIconButton
              variant="outline"
              disabled={currentPage <= 1}
              onClick={() => onPageChange(currentPage - 1)}
              tooltip={t('common.previousPage')}
            >
              <ChevronLeft className="icon-sm" />
            </TooltipIconButton>
            <span className="px-2 text-sm text-muted-foreground">
              {currentPage} / {totalPages}
            </span>
            <TooltipIconButton
              variant="outline"
              disabled={currentPage >= totalPages}
              onClick={() => onPageChange(currentPage + 1)}
              tooltip={t('common.nextPage')}
            >
              <ChevronRight className="icon-sm" />
            </TooltipIconButton>
          </div>
        </div>
      )}
    </div>
  );
}
