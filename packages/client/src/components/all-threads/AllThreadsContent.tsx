import type { Thread } from '@funny/shared';
import type { KeyboardEvent, MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { AllThreadsThreadList } from '@/components/all-threads/AllThreadsThreadList';
import { KanbanView } from '@/components/KanbanView';

interface Props {
  viewMode: 'list' | 'board';
  threads: Thread[];
  search: string;
  caseSensitive: boolean;
  contentMatches: Map<string, string>;
  highlightThreadId?: string;
  projectFilter: string | null;
  projectInfoById: Record<string, { name: string; path: string; color?: string }>;
  hasMoreServerThreads: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  searchKeyDownRef: MutableRefObject<((e: KeyboardEvent) => void) | null>;
}

/**
 * The thread-content area of AllThreadsView: either a KanbanView (board
 * mode) or the sidebar-style thread list (list mode). Extracted so the parent
 * fits inside the 150-line function lint limit.
 */
export function AllThreadsContent({
  viewMode,
  threads,
  search,
  caseSensitive,
  contentMatches,
  highlightThreadId,
  projectFilter,
  projectInfoById,
  hasMoreServerThreads,
  loadingMore,
  onLoadMore,
  searchKeyDownRef,
}: Props) {
  const { t } = useTranslation();

  if (viewMode === 'board') {
    return (
      <div className="min-h-0 flex-1">
        <KanbanView
          threads={threads}
          projectId={projectFilter || undefined}
          search={search}
          caseSensitive={caseSensitive}
          contentSnippets={contentMatches}
          highlightThreadId={highlightThreadId}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
      <AllThreadsThreadList
        threads={threads}
        search={search}
        caseSensitive={caseSensitive}
        contentSnippets={contentMatches}
        emptyMessage={t('allThreads.noThreads')}
        searchEmptyMessage={t('allThreads.noMatch')}
        projectFilter={projectFilter}
        projectInfoById={projectInfoById}
        hasMore={hasMoreServerThreads}
        loadingMore={loadingMore}
        onEndReached={onLoadMore}
        onSearchKeyDownRef={searchKeyDownRef}
      />
    </div>
  );
}
