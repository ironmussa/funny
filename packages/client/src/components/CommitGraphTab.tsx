import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  GRAPH_BASE_ROW_H,
  GRAPH_REFS_ROW_H,
  graphRowHeight,
} from '@/components/commit-graph/graph-entry';
import { GraphCommitList } from '@/components/commit-graph/GraphCommitList';
import type { GraphCommitRowSharedProps } from '@/components/commit-graph/GraphCommitRow';
import { GraphGutterHorizontalScroller } from '@/components/commit-graph/GraphGutterHorizontalScroller';
import { graphListStatus } from '@/components/commit-graph/GraphListStatus';
import { GraphToolbar } from '@/components/commit-graph/GraphToolbar';
import { GraphWipRow } from '@/components/commit-graph/GraphWipRow';
import { RebaseEventDialog } from '@/components/commit-graph/RebaseEventDialog';
import { useBranchActions } from '@/components/commit-graph/use-branch-actions';
import { useCommitGraphLog } from '@/components/commit-graph/use-commit-graph-log';
import { useEmailAvatars } from '@/components/commit-graph/use-email-avatars';
import { useGraphFilters } from '@/components/commit-graph/use-graph-filters';
import { useGraphGitContext } from '@/components/commit-graph/use-graph-git-context';
import { useGraphHorizontalScroll } from '@/components/commit-graph/use-graph-horizontal-scroll';
import {
  useGithubBrowseBaseUrl,
  useGithubCommitAvatars,
  useRebaseEvents,
} from '@/components/commit-graph/use-graph-remote-data';
import { useGraphView } from '@/components/commit-graph/use-graph-view';
import { useGraphVirtualizer } from '@/components/commit-graph/use-graph-virtualizer';
import { useScrollToThreadBranch } from '@/components/commit-graph/use-scroll-to-thread-branch';
import { CommitDetailDialog } from '@/components/commit-history/CommitDetailDialog';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SearchBar } from '@/components/ui/search-bar';
import { useStartThreadOnBranch } from '@/hooks/use-start-thread-on-branch';
import { useWorkingTreeStatus } from '@/hooks/use-working-tree-status';
import { graphHeadHash, summarizeGraphBranches } from '@/lib/graph-refs';

// The graph's pieces live in `commit-graph/`; these are re-exported for the
// callers and tests that import them from here.
export { findThreadBranchRowIndex, titleYForRow } from '@/components/commit-graph/graph-entry';
export {
  GraphCommitSyncMarkers,
  GraphCommitTime,
} from '@/components/commit-graph/GraphCommitMarkers';
export { GraphGutterHorizontalScroller } from '@/components/commit-graph/GraphGutterHorizontalScroller';
export { GraphWipRow } from '@/components/commit-graph/GraphWipRow';
export { RebaseCopyLinksOverlay } from '@/components/commit-graph/RebaseCopyLinksOverlay';

interface CommitGraphTabProps {
  visible?: boolean;
}

/**
 * Branch-graph view of git history: a GitKraken-style lane graph on the left
 * of each commit, from `git log --all --date-order` data (parents + refs).
 * Each commit shows GitHub avatar(s), copy-hash, a remote commit link when
 * available, and an unpushed marker. Click a commit to open the
 * {@link CommitDetailDialog}.
 */
export function CommitGraphTab({ visible }: CommitGraphTabProps) {
  const { t } = useTranslation();
  const baseRowH = GRAPH_BASE_ROW_H;
  const refsRowH = GRAPH_REFS_ROW_H;
  const rowHeightFor = graphRowHeight;
  const { effectiveThreadId, projectModeId, gitThread, threadBranchField, hasGitContext } =
    useGraphGitContext();

  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const filters = useGraphFilters();
  const { searchQuery, syncFilter, authors } = filters;
  const { rebaseEvents, selectedRebaseEvent, setSelectedRebaseEvent, resetRebaseEvents } =
    useRebaseEvents({ visible, hasGitContext, effectiveThreadId, projectModeId });
  const {
    entries,
    logLoading,
    logErrorMessage,
    hasMore,
    branchScope,
    setBranchScope,
    unpushed,
    unpulled,
    gitContextKey,
    loadMore,
    refreshLog,
    invalidateHistory,
    updateSearchQuery,
  } = useCommitGraphLog({
    visible,
    hasGitContext,
    effectiveThreadId,
    projectModeId,
    contextProjectId: gitThread?.projectId,
    filters,
    onContextReset: resetRebaseEvents,
  });
  const avatarByEmail = useEmailAvatars(entries);

  // The project whose remote resolves commit links and GitHub avatars.
  const remoteProjectId = projectModeId ?? (effectiveThreadId ? gitThread?.projectId : null);
  const githubBrowseBaseUrl = useGithubBrowseBaseUrl(remoteProjectId);
  const startThreadOnBranch = useStartThreadOnBranch();
  const createThreadFromBranch = useMemo(
    () =>
      remoteProjectId ? (branch: string) => startThreadOnBranch(remoteProjectId, branch) : null,
    [remoteProjectId, startThreadOnBranch],
  );
  const githubAvatarBySha = useGithubCommitAvatars(remoteProjectId, entries, gitContextKey);

  const view = useGraphView({
    entries,
    searchQuery,
    syncFilter,
    authors,
    unpushed,
    unpulled,
    rebaseEvents,
  });
  const { isFiltering, displayEntries, layout, laneCount, gutterWidth } = view;
  const rootRef = useRef<HTMLDivElement>(null);
  const {
    graphHorizontalScrollRef,
    graphViewportWidth,
    graphMaxScrollLeft,
    clampedGraphScrollLeft,
    updateGraphScrollLeft,
    handleGraphGutterWheel,
  } = useGraphHorizontalScroll(rootRef, gutterWidth);

  // Working-tree status drives the WIP "Uncommitted changes" node above the list
  // and the dashed stub that ties the HEAD row up to it. Lifted here (rather than
  // inside GraphWipRow) so the HEAD commit row can also know whether to draw the
  // connector — `wipStatus` is non-null only when there are changes worth showing.
  const { status: wipRawStatus, dirty: wipDirty } = useWorkingTreeStatus(
    effectiveThreadId,
    projectModeId,
    !!visible && hasGitContext && entries.length > 0,
  );
  const wipStatus = !isFiltering && wipDirty ? wipRawStatus : undefined;
  // Rows from the top down to HEAD carry the dashed line to the WIP node. When
  // HEAD is not in the window, only the first row does (a stub to the top edge).
  const headIndex = useMemo(() => {
    const headHash = graphHeadHash(displayEntries);
    return headHash ? displayEntries.findIndex((entry) => entry.hash === headHash) : -1;
  }, [displayEntries]);
  const lastWipRowIndex = wipStatus ? Math.max(headIndex, 0) : -1;

  const { scrollRef, virtualizer, virtualItems, totalSize } = useGraphVirtualizer({
    displayEntries,
    loadedCount: entries.length,
    // The infinite-scroll sentinel only applies to the full (unfiltered) list;
    // while filtering we page eagerly in the background instead (see useCommitGraphLog).
    showSentinel: !isFiltering && hasMore,
    baseRowH,
    refsRowH,
    rowHeightFor,
    loadMore,
  });

  const clearSearch = useCallback(() => {
    updateSearchQuery('');
  }, [updateSearchQuery]);

  const selectedCommit = entries.find((e) => e.hash === selectedHash);
  const branchSummaries = useMemo(() => summarizeGraphBranches(entries), [entries]);
  const branchSummaryByName = useMemo(
    () => new Map(branchSummaries.map((branch) => [branch.branch, branch])),
    [branchSummaries],
  );

  // The branch the open thread works on: its own branch, or (a local thread
  // with no recorded branch) the branch checked out where it runs.
  const threadBranch = effectiveThreadId
    ? threadBranchField || branchSummaries.find((b) => b.isCurrent)?.branch || null
    : null;
  useScrollToThreadBranch({
    threadId: effectiveThreadId,
    threadBranch,
    entries: displayEntries,
    visible: !!visible,
    virtualizer,
  });

  const { branchActionInProgress, pushBranch, pullCurrentBranch } = useBranchActions({
    hasGitContext,
    effectiveThreadId,
    projectModeId,
    invalidateHistory,
  });

  // Shared by every commit row; its own memo so it keeps its identity while
  // only the scroll position changes (the rows are memoized on it).
  // Shared by every commit row (the rows are memoized on it). Built on its own,
  // outside the list's JSX, so the compiler memoizes it on these values alone
  // and it keeps its identity while only the scroll position changes.
  const rowProps: GraphCommitRowSharedProps = {
    laneCount,
    gutterWidth,
    graphViewportWidth,
    graphScrollLeft: clampedGraphScrollLeft,
    onGraphGutterWheel: handleGraphGutterWheel,
    githubBrowseBaseUrl,
    effectiveThreadId,
    projectModeId,
    prProjectId: remoteProjectId || undefined,
    onAfterAction: refreshLog,
    onCreateThreadFromBranch: createThreadFromBranch,
    branchSummaryByName,
    branchActionInProgress,
    onPushBranch: pushBranch,
    onPullCurrentBranch: pullCurrentBranch,
    onSelectRebaseEvent: setSelectedRebaseEvent,
    branchColorByLabel: view.branchColorByLabel,
    searchQuery,
    threadBranch,
  };

  if (!hasGitContext) {
    return (
      <EmptyState fill={false} title={t('review.noProject', 'Select a project to view history')} />
    );
  }

  return (
    <div
      ref={rootRef}
      className="flex h-full w-full min-w-0 flex-col overflow-hidden"
      data-testid="commit-graph-tab"
    >
      <GraphToolbar
        logLoading={logLoading}
        branchScope={branchScope}
        commitCount={displayEntries.length}
        syncFilter={syncFilter}
        authors={authors}
        hasMoreAuthors={hasMore}
        onLoadMoreAuthors={loadMore}
        authorOptions={view.authorOptions}
        onAuthorsChange={filters.updateAuthors}
        onAuthorOpenChange={filters.updateAuthorOptionsOpen}
        onToggleSyncFilter={filters.toggleSyncFilter}
        onRefresh={refreshLog}
        onBranchScopeChange={setBranchScope}
      />

      <div className="border-sidebar-border bg-background border-b px-2 py-1">
        <SearchBar
          query={searchQuery}
          onQueryChange={updateSearchQuery}
          totalMatches={displayEntries.length}
          loading={isFiltering && logLoading}
          onClose={searchQuery.trim() ? clearSearch : undefined}
          autoFocus={false}
          placeholder={t('graph.searchPlaceholder', 'Search branches & commits')}
          testIdPrefix="graph-search"
          resultLabel={
            isFiltering
              ? t('graph.matchCount', {
                  count: displayEntries.length,
                  defaultValue: `${displayEntries.length} matches`,
                })
              : ''
          }
        />
      </div>

      {!isFiltering && wipStatus && (
        <GraphWipRow
          status={wipStatus}
          firstRow={layout.rows[Math.max(headIndex, 0)]}
          laneCount={laneCount}
          gutterWidth={gutterWidth}
          graphViewportWidth={graphViewportWidth}
          graphScrollLeft={clampedGraphScrollLeft}
          onGraphGutterWheel={handleGraphGutterWheel}
          rowHeight={baseRowH}
        />
      )}

      <div className="flex flex-1 flex-col overflow-x-hidden overflow-y-auto" ref={scrollRef}>
        {graphListStatus({
          t,
          loadingFirstPage: logLoading && entries.length === 0,
          logErrorMessage,
          isEmpty: displayEntries.length === 0,
          isFiltering,
          onRetry: refreshLog,
        }) ?? (
          <GraphCommitList
            totalSize={totalSize}
            virtualItems={virtualItems}
            view={view}
            rowProps={rowProps}
            baseRowH={baseRowH}
            rowHeightFor={rowHeightFor}
            selectedHash={selectedHash}
            onSelectHash={setSelectedHash}
            githubAvatarBySha={githubAvatarBySha}
            avatarByEmail={avatarByEmail}
            unpushed={unpushed}
            unpulled={unpulled}
            lastWipRowIndex={lastWipRowIndex}
          />
        )}
      </div>

      {isFiltering && hasMore && !logErrorMessage && (
        <Button
          variant="ghost"
          size="sm"
          onClick={loadMore}
          disabled={logLoading}
          className="shrink-0"
          data-testid="graph-filter-load-more"
        >
          {t('history.loadMore', 'Load more commits')}
        </Button>
      )}

      {graphMaxScrollLeft > 0 && (
        <GraphGutterHorizontalScroller
          scrollbarRef={graphHorizontalScrollRef}
          graphViewportWidth={graphViewportWidth}
          gutterWidth={gutterWidth}
          onScrollLeftChange={updateGraphScrollLeft}
        />
      )}

      <CommitDetailDialog
        selectedCommit={selectedCommit}
        selectedHash={selectedHash}
        effectiveThreadId={effectiveThreadId}
        projectModeId={projectModeId}
        githubAvatarBySha={githubAvatarBySha}
        onClose={() => setSelectedHash(null)}
        onAfterAction={refreshLog}
      />
      <RebaseEventDialog event={selectedRebaseEvent} onClose={() => setSelectedRebaseEvent(null)} />
    </div>
  );
}
