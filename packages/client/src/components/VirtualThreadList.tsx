import type { Thread } from '@funny/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Loader2 } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BranchBadge } from '@/components/BranchBadge';
import { ThreadTitle } from '@/components/thread/ThreadAttachmentsBadge';
import { ThreadStatusPin } from '@/components/thread/ThreadStatusPin';
import { HighlightText, normalize } from '@/components/ui/highlight-text';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { timeAgo } from '@/lib/thread-utils';
import { cn, resolveThreadBranch } from '@/lib/utils';
import { useThreadStore } from '@/stores/thread-store';

const ROW_ESTIMATE_PX = 60;
const LOAD_MORE_THRESHOLD = 5;

interface VirtualThreadListProps {
  threads: Thread[];
  search: string;
  contentSnippets?: Map<string, string>;
  emptyMessage: string;
  searchEmptyMessage: string;
  onThreadClick?: (thread: Thread) => void;
  renderExtraBadges?: (thread: Thread) => ReactNode;
  renderActions?: (thread: Thread) => ReactNode;
  hideBranch?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onEndReached?: () => void;
  onSearchKeyDownRef?: React.MutableRefObject<((e: React.KeyboardEvent) => void) | null>;
  className?: string;
}

export function VirtualThreadList({
  threads,
  search,
  contentSnippets,
  emptyMessage,
  searchEmptyMessage,
  onThreadClick,
  renderExtraBadges,
  renderActions,
  hideBranch = false,
  hasMore = false,
  loadingMore = false,
  onEndReached,
  onSearchKeyDownRef,
  className,
}: VirtualThreadListProps) {
  const { t } = useTranslation();
  useMinuteTick();
  const pinThread = useThreadStore((s) => s.pinThread);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [highlightIndex, setHighlightIndex] = useState(-1);

  const virtualizer = useVirtualizer({
    count: threads.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    getItemKey: (index) => threads[index]?.id ?? index,
    overscan: 10,
  });

  useEffect(() => {
    setHighlightIndex(-1);
  }, [search, threads]);

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!onThreadClick || threads.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = highlightIndex < threads.length - 1 ? highlightIndex + 1 : 0;
        setHighlightIndex(next);
        virtualizer.scrollToIndex(next, { align: 'auto' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = highlightIndex > 0 ? highlightIndex - 1 : threads.length - 1;
        setHighlightIndex(prev);
        virtualizer.scrollToIndex(prev, { align: 'auto' });
      } else if (e.key === 'Enter' && highlightIndex >= 0 && highlightIndex < threads.length) {
        e.preventDefault();
        onThreadClick(threads[highlightIndex]);
      }
    },
    [threads, onThreadClick, highlightIndex, virtualizer],
  );

  useEffect(() => {
    if (!onSearchKeyDownRef) return;
    onSearchKeyDownRef.current = handleSearchKeyDown;
    return () => {
      if (onSearchKeyDownRef) onSearchKeyDownRef.current = null;
    };
  }, [onSearchKeyDownRef, handleSearchKeyDown]);

  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => {
    if (!hasMore || loadingMore || !onEndReached) return;
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= threads.length - 1 - LOAD_MORE_THRESHOLD) {
      onEndReached();
    }
  }, [virtualItems, hasMore, loadingMore, onEndReached, threads.length]);

  if (threads.length === 0) {
    return (
      <div
        className={cn(
          'flex h-32 items-center justify-center text-xs text-muted-foreground',
          className,
        )}
      >
        {search ? searchEmptyMessage : emptyMessage}
      </div>
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div
        ref={scrollRef}
        data-testid="virtual-thread-list-scroll"
        className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/50"
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map((v) => {
            const thread = threads[v.index];
            if (!thread) return null;
            const Wrapper = onThreadClick ? 'button' : 'div';
            return (
              <Wrapper
                key={v.key}
                data-index={v.index}
                data-testid={`virtual-thread-item-${thread.id}`}
                ref={virtualizer.measureElement as never}
                {...(onThreadClick ? { onClick: () => onThreadClick(thread) } : {})}
                onMouseMove={() => setHighlightIndex(v.index)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2.5 border-b border-border/50 group/row outline-none',
                  onThreadClick && 'text-left hover:bg-accent/50 transition-colors',
                  v.index === highlightIndex && 'bg-accent/50',
                )}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  transform: `translateY(${v.start}px)`,
                }}
              >
                <ThreadStatusPin
                  thread={thread}
                  onPin={(pinned) => pinThread(thread.id, thread.projectId, pinned)}
                  hoverGroup="row"
                  showStatusTooltip
                />

                <div className="min-w-0 flex-1">
                  <ThreadTitle
                    title={thread.title}
                    search={search}
                    className="block text-sm font-medium"
                    badgeTestId={`virtual-thread-item-attachments-${thread.id}`}
                    stopBadgePropagation
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
        </div>
        {loadingMore && (
          <div
            data-testid="virtual-thread-list-loading-more"
            className="flex items-center justify-center gap-1.5 py-3 text-xs text-muted-foreground"
          >
            <Loader2 className="icon-sm animate-spin" />
            {t('common.loading')}
          </div>
        )}
      </div>
    </div>
  );
}
