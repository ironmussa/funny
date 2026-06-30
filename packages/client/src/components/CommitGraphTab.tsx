import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  GitBranch,
  GitCommit,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { CommitActionsMenu } from '@/components/commit-graph/CommitActionsMenu';
import { GraphGutter, LANE_WIDTH } from '@/components/commit-graph/GraphGutter';
import { GraphRefChips } from '@/components/commit-graph/GraphRefChips';
import { CommitDetailDialog } from '@/components/commit-history/CommitDetailDialog';
import { DiffStats } from '@/components/DiffStats';
import { PRBadge } from '@/components/PRBadge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { HighlightText } from '@/components/ui/highlight-text';
import { HoverTimeMenu } from '@/components/ui/hover-time-menu';
import { LoadingState } from '@/components/ui/loading-state';
import { SearchBar } from '@/components/ui/search-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useRightPaneProjectId, useRightPaneThreadId } from '@/hooks/use-right-pane-target';
import { useWorkingTreeStatus } from '@/hooks/use-working-tree-status';
import { api } from '@/lib/api';
import type { GitRebaseReflogEventDTO, GraphRefDTO } from '@/lib/api/git';
import { authorAvatarUrl } from '@/lib/author-avatar';
import { useCachedAvatar } from '@/lib/avatar-cache';
import { createClientLogger } from '@/lib/client-logger';
import { computeGraphRows, type GraphRow } from '@/lib/git-graph-lanes';
import { commitMatchesQuery } from '@/lib/git-history-search';
import {
  githubBrowseBaseUrl as resolveGithubBrowseBaseUrl,
  githubCommitUrlForRemoteCommit,
} from '@/lib/github-url';
import { graphLanePastel } from '@/lib/graph-colors';
import {
  foldGraphRefs,
  graphNodeForkedFromRefLabels,
  graphNodeParentLabels,
  graphNodeParentRefLabels,
  type GraphNodeParentLabel,
  inferUnpulledHashesFromGraphEntries,
  summarizeGraphBranches,
  type GraphBranchSummary,
} from '@/lib/graph-refs';
import {
  indexRebaseEventsByHash,
  inferRebaseCopyLinks,
  type RebaseCopyLink,
} from '@/lib/rebase-events';
import {
  rebaseCopyLinkRailLane,
  rebaseCopyLinkRailX,
  rebaseCopyLinkUsesOuterRail,
  roundedRebaseCopyLinkPath,
} from '@/lib/rebase-link-path';
import { metric } from '@/lib/telemetry';
import { middleTruncate } from '@/lib/text-truncate';
import { shortRelativeDate } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useThreadProjectId } from '@/stores/thread-context';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('commit-graph');

// Process-lifetime cache of resolved email → avatar URL (GitHub .png / Gravatar),
// shared across remounts so we don't re-hash the same emails. Mirrors AuthorBadge.
const emailAvatarCache = new Map<string, string>();

interface GraphEntry {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  committer: string;
  committerEmail: string;
  relativeDate: string;
  message: string;
  body: string;
  parentHashes: string[];
  refs: GraphRefDTO[];
  /** Checked-out branch, set only on the commit HEAD points at (else null). */
  headBranch: string | null;
}

function hasDistinctCommitterIdentity(entry: GraphEntry): boolean {
  return (
    !!entry.committer &&
    (entry.committer !== entry.author ||
      (!!entry.committerEmail && entry.committerEmail !== entry.authorEmail))
  );
}

const PAGE_SIZE = 80;
// The title/meta text is rendered with the SAME Tailwind classes as the History
// list (`text-xs` + `text-[10px]`) so the font is identical across every
// Review-pane tab. These px values are only used to *estimate* row heights for
// the virtualizer — `text-xs` resolves to ~10.5px at the app's 14px rem base,
// and `text-[10px]` is an absolute 10px.
const TITLE_PX = 10.5;
const META_PX = 10;
const REBASE_LINK_RAIL_WIDTH = LANE_WIDTH;
const PARENT_BRANCH_LABEL_MAX_CHARS = 40;
// Upper bound on how many commits the active-filter background pager will pull
// in, so filtering a huge repo can't page the entire history into memory.
const FILTER_MAX_SCAN = 2000;

interface CommitGraphTabProps {
  visible?: boolean;
}

function graphNodeX(lane: number): number {
  return 12 + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function rebaseLinkNodeEdgeX(lane: number): number {
  return graphNodeX(lane) + LANE_WIDTH / 2 + 2;
}

export function renderedGraphLaneCount(layoutLaneCount: number): number {
  return Math.max(layoutLaneCount, 1);
}

/**
 * Branch-graph view of git history. Separate from {@link CommitHistoryTab}
 * (the flat list) — this one renders a GitKraken-style lane graph on the left
 * of each commit using `git log --all --date-order` data (parents + refs).
 * Per-commit affordances mirror the History list: GitHub avatar(s), copy-hash,
 * remote commit link when available, and an unpushed marker. Click a commit to
 * open the shared {@link CommitDetailDialog}.
 */
export function CommitGraphTab({ visible }: CommitGraphTabProps) {
  const { t } = useTranslation();
  // Typography is fixed to match the History list so the font is identical
  // across every Review-pane tab (see TITLE_PX / META_PX above).
  const titlePx = TITLE_PX;
  const metaPx = META_PX;
  // Variable row heights: the title sits on one line, so ref-less rows are a
  // single tight line; rows with branch/tag chips get an extra line above. Computed
  // from the font sizes — no magic numbers — so ref-less rows (the majority) stay
  // compact instead of padding to a fixed max.
  const baseRowH = Math.round(titlePx * 1.5) + 6;
  // Rows with ref chips get an extra line for the powerline plus a little more
  // breathing room so the chips don't crowd the commit title below them.
  const refsRowH = baseRowH + (metaPx + 5) + 6;
  const rowHeightFor = useCallback(
    (e: GraphEntry) => (e.refs.length > 0 ? refsRowH : baseRowH),
    [baseRowH, refsRowH],
  );
  const selectedProjectId = useRightPaneProjectId();
  const effectiveThreadId = useRightPaneThreadId() || undefined;
  const projectModeId = !effectiveThreadId ? selectedProjectId : null;
  const threadProjectId = useThreadProjectId();
  const hasGitContext = !!(effectiveThreadId || projectModeId);

  const [entries, setEntries] = useState<GraphEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logErrorMessage, setLogErrorMessage] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [allBranches, setAllBranches] = useState(true);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [unpushed, setUnpushed] = useState<Set<string>>(new Set());
  const [unpulled, setUnpulled] = useState<Set<string>>(new Set());
  const [branchActionInProgress, setBranchActionInProgress] = useState<string | null>(null);
  const [rebaseEvents, setRebaseEvents] = useState<GitRebaseReflogEventDTO[]>([]);
  const [selectedRebaseEvent, setSelectedRebaseEvent] = useState<GitRebaseReflogEventDTO | null>(
    null,
  );
  const [githubAvatarBySha, setGithubAvatarBySha] = useState<Map<string, string>>(new Map());
  const avatarByEmail = useEmailAvatars(entries);
  const [githubBrowseBaseUrl, setGithubBrowseBaseUrl] = useState<string | null>(null);

  // Search bar (always visible): a list FILTER over the loaded commits, matching
  // the commit's subject, body, or any branch/tag ref it carries (see
  // commitMatchesQuery).
  const [searchQuery, setSearchQuery] = useState('');

  const loadingRef = useRef(false);
  const loadedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Synchronous mirror of the loaded entries so the background pager can append
  // without a stale closure over React state.
  const entriesRef = useRef<GraphEntry[]>([]);

  const gitContextKey = `${effectiveThreadId || projectModeId || ''}::${allBranches}`;

  const loadLog = useCallback(
    async (
      skip = 0,
      append = false,
    ): Promise<{ entries: GraphEntry[]; hasMore: boolean } | null> => {
      if (!hasGitContext || loadingRef.current) return null;
      loadingRef.current = true;
      setLogLoading(true);
      if (!append) setLogErrorMessage(null);
      const started = performance.now();
      const signal = abortRef.current?.signal;
      const result = effectiveThreadId
        ? await api.getGitGraphLog(effectiveThreadId, PAGE_SIZE, allBranches, skip, signal)
        : await api.projectGitGraphLog(projectModeId!, PAGE_SIZE, allBranches, skip, signal);
      if (signal?.aborted) {
        loadingRef.current = false;
        return null;
      }
      let out: { entries: GraphEntry[]; hasMore: boolean } | null = null;
      if (result.isOk()) {
        const { entries: next, hasMore: more, unpushedHashes, unpulledHashes = [] } = result.value;
        setLogErrorMessage(null);
        const merged = append ? [...entriesRef.current, ...next] : next;
        // Keep the synchronous mirror current so the next append builds on the
        // freshly-loaded page without waiting for a React re-render.
        entriesRef.current = merged;
        setEntries(merged);
        setHasMore(more);
        setUnpushed((prev) => {
          if (!append) return new Set(unpushedHashes);
          const updated = new Set(prev);
          for (const h of unpushedHashes) updated.add(h);
          return updated;
        });
        setUnpulled((prev) => {
          if (!append) return new Set(unpulledHashes);
          const updated = new Set(prev);
          for (const h of unpulledHashes) updated.add(h);
          return updated;
        });
        metric('git.graph_log.loaded', performance.now() - started, {
          attributes: { count: String(next.length), append: String(append) },
        });
        out = { entries: merged, hasMore: more };
      } else if (result.error.message !== 'Request aborted') {
        log.warn('graph-log load failed', { error: result.error.message });
        setLogErrorMessage(result.error.message);
        toast.error(
          t('review.logFailed', {
            message: result.error.message,
            defaultValue: `Failed to load log: ${result.error.message}`,
          }),
        );
      }
      setLogLoading(false);
      loadingRef.current = false;
      return out;
    },
    [hasGitContext, effectiveThreadId, projectModeId, allBranches, t],
  );

  const loadMore = useCallback(() => {
    if (!hasMore || loadingRef.current) return;
    loadLog(entries.length, true);
  }, [hasMore, entries.length, loadLog]);

  const refreshLog = useCallback(() => {
    loadedRef.current = true;
    loadLog(0, false);
  }, [loadLog]);

  // (Re)load whenever the context (thread/project or all-branches toggle) changes.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    loadingRef.current = false;
    loadedRef.current = false;
    entriesRef.current = [];
    setEntries([]);
    setHasMore(false);
    setLogErrorMessage(null);
    setUnpushed(new Set());
    setUnpulled(new Set());
    setRebaseEvents([]);
    setSelectedRebaseEvent(null);
    // Drop the filter query — it belongs to the old context.
    setSearchQuery('');
    if (visible && hasGitContext) {
      loadedRef.current = true;
      loadLog(0, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-doctor/exhaustive-deps -- intentionally only on context change
  }, [gitContextKey]);

  // Load on first reveal if the tab mounted while hidden.
  useEffect(() => {
    if (visible && hasGitContext && !loadedRef.current) {
      loadedRef.current = true;
      // eslint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- first reveal intentionally triggers the initial graph fetch once.
      loadLog(0, false);
    }
  }, [visible, hasGitContext, loadLog]);

  useEffect(() => {
    if (!visible || !hasGitContext) return;
    const controller = new AbortController();
    const request = effectiveThreadId
      ? api.getReflogEvents(effectiveThreadId, controller.signal)
      : api.projectReflogEvents(projectModeId!, controller.signal);
    request.then((result) => {
      if (controller.signal.aborted) return;
      if (result.isOk()) {
        setRebaseEvents(result.value.events);
      } else if (result.error.message !== 'Request aborted') {
        log.warn('reflog-events load failed', { error: result.error.message });
        setRebaseEvents([]);
      }
    });
    return () => controller.abort();
  }, [visible, hasGitContext, effectiveThreadId, projectModeId]);

  // Resolve the GitHub browse base URL so commit hashes can deep-link.
  const remoteCheckProjectId = projectModeId ?? selectedProjectId ?? threadProjectId ?? null;
  useEffect(() => {
    if (!remoteCheckProjectId) {
      setGithubBrowseBaseUrl(null);
      return;
    }
    const controller = new AbortController();
    api.projectGetRemoteUrl(remoteCheckProjectId, controller.signal).then((r) => {
      if (controller.signal.aborted || !r.isOk()) return;
      setGithubBrowseBaseUrl(resolveGithubBrowseBaseUrl(r.value.remoteUrl));
    });
    return () => controller.abort();
  }, [remoteCheckProjectId]);

  // Reset avatars when the git context changes.
  const anchoredShasRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    setGithubAvatarBySha(new Map());
    anchoredShasRef.current = new Set();
  }, [gitContextKey]);

  // Walk the GitHub commit-author endpoint, anchored at the first uncovered SHA,
  // to fill in avatar URLs (same strategy as the History list).
  const ghProjectId = projectModeId ?? selectedProjectId ?? threadProjectId ?? null;
  useEffect(() => {
    if (!ghProjectId || entries.length === 0) return;
    const firstMissing = entries.find(
      (e) => !githubAvatarBySha.has(e.hash) && !anchoredShasRef.current.has(e.hash),
    );
    if (!firstMissing) return;
    anchoredShasRef.current.add(firstMissing.hash);
    let cancelled = false;
    api
      .githubCommitAuthors(ghProjectId, {
        sha: firstMissing.hash,
        per_page: 100,
      })
      .then((result) => {
        if (cancelled || result.isErr()) return;
        const authors = result.value.authors;
        if (authors.length === 0) return;
        setGithubAvatarBySha((prev) => {
          const next = new Map(prev);
          for (const a of authors) if (a.avatar_url) next.set(a.sha, a.avatar_url);
          return next;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [ghProjectId, entries, githubAvatarBySha]);

  const isFiltering = searchQuery.trim().length > 0;
  const displayEntries = useMemo(
    () => (isFiltering ? entries.filter((e) => commitMatchesQuery(e, searchQuery)) : entries),
    [entries, searchQuery, isFiltering],
  );
  const inferredUnpulled = useMemo(() => inferUnpulledHashesFromGraphEntries(entries), [entries]);
  const rebaseEventsByHash = useMemo(() => indexRebaseEventsByHash(rebaseEvents), [rebaseEvents]);
  const rebaseCopyLinks = useMemo(
    () => (isFiltering ? [] : inferRebaseCopyLinks(rebaseEvents, displayEntries)),
    [displayEntries, isFiltering, rebaseEvents],
  );
  const rebaseParentRefLabelByHash = useMemo(
    () => graphNodeParentRefLabels(rebaseCopyLinks, displayEntries),
    [displayEntries, rebaseCopyLinks],
  );
  const forkedFromRefLabelByHash = useMemo(
    () => (isFiltering ? new Map<string, string>() : graphNodeForkedFromRefLabels(displayEntries)),
    [displayEntries, isFiltering],
  );
  const parentLabelByHash = useMemo(() => graphNodeParentLabels(displayEntries), [displayEntries]);

  const layout = useMemo(() => {
    // While filtering, the surviving commits are no longer contiguous in topo
    // order, so the lane graph would render as a meaningless staircase. Show a
    // flat list instead: one standalone node per row, no connecting rails.
    if (isFiltering) {
      return {
        rows: displayEntries.map(() => ({
          commitLane: 0,
          nodeColor: 0,
          segments: [],
        })),
        laneCount: 1,
      };
    }
    return computeGraphRows(
      displayEntries.map((e) => ({
        hash: e.hash,
        parentHashes: e.parentHashes,
      })),
    );
  }, [displayEntries, isFiltering]);
  const laneCount = renderedGraphLaneCount(layout.laneCount);
  const laneGutterWidth = laneCount * LANE_WIDTH;
  const rebaseRailWidth = useMemo(() => {
    if (rebaseCopyLinks.length === 0) return 0;
    const laneByHash = new Map<string, number>();
    for (let index = 0; index < displayEntries.length; index += 1) {
      const row = layout.rows[index];
      if (row) laneByHash.set(displayEntries[index].hash, row.commitLane);
    }
    for (const link of rebaseCopyLinks) {
      const targetLane = laneByHash.get(link.targetHash);
      if (targetLane === undefined) continue;
      const sourceLane = laneByHash.get(link.sourceHash) ?? null;
      if (rebaseCopyLinkUsesOuterRail({ sourceLane, targetLane, laneCount })) {
        return REBASE_LINK_RAIL_WIDTH;
      }
    }
    return 0;
  }, [displayEntries, laneCount, layout.rows, rebaseCopyLinks]);
  const gutterWidth = laneGutterWidth + rebaseRailWidth;

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

  const scrollRef = useRef<HTMLDivElement>(null);
  // The infinite-scroll sentinel only applies to the full (unfiltered) list;
  // while filtering we page eagerly in the background instead (see below).
  const showSentinel = !isFiltering && hasMore;
  const rowCount = displayEntries.length + (showSentinel ? 1 : 0);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      index >= displayEntries.length ? baseRowH : rowHeightFor(displayEntries[index]),
    getItemKey: (index) =>
      index >= displayEntries.length ? '__sentinel__' : displayEntries[index].hash,
    overscan: 12,
  });

  // Re-measure when the row heights change (font-size setting toggled).
  useEffect(() => {
    virtualizer.measure();
  }, [baseRowH, refsRowH, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems[virtualItems.length - 1]?.index;
  useEffect(() => {
    if (!showSentinel || lastIndex === undefined) return;
    if (lastIndex >= entries.length - 5) loadMore();
  }, [lastIndex, entries.length, showSentinel, loadMore]);

  // ── Search filter ────────────────────────────────────────────────────────
  // The filter can only match commits that are loaded, but the log is paginated.
  // While a query is active, eagerly page through history (bounded) so matches
  // deeper than the first page still surface without the user scrolling.
  useEffect(() => {
    if (!isFiltering || !hasMore || loadingRef.current) return;
    if (entries.length >= FILTER_MAX_SCAN) return;
    void loadLog(entries.length, true);
  }, [isFiltering, hasMore, entries.length, loadLog]);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
  }, []);

  const selectedCommit = entries.find((e) => e.hash === selectedHash);
  const branchSummaries = useMemo(() => summarizeGraphBranches(entries), [entries]);
  const branchSummaryByName = useMemo(
    () => new Map(branchSummaries.map((branch) => [branch.branch, branch])),
    [branchSummaries],
  );

  const refreshGitStatus = useCallback(() => {
    if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId, true);
    else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId, true);
  }, [effectiveThreadId, projectModeId]);

  const pushBranch = useCallback(
    async (branch: string) => {
      if (!hasGitContext || branchActionInProgress) return;
      setBranchActionInProgress(`push:${branch}`);
      const result = effectiveThreadId
        ? await api.pushBranch(effectiveThreadId, branch)
        : await api.projectPushBranch(projectModeId!, branch);
      if (result.isOk()) {
        toast.success(
          t('history.pushBranchSuccess', {
            branch,
            defaultValue: `Pushed ${branch} to origin`,
          }),
        );
      } else {
        toast.error(
          t('review.pushFailed', {
            message: result.error.message,
            defaultValue: `Push failed: ${result.error.message}`,
          }),
        );
      }
      setBranchActionInProgress(null);
      refreshGitStatus();
      refreshLog();
    },
    [
      hasGitContext,
      branchActionInProgress,
      effectiveThreadId,
      projectModeId,
      refreshGitStatus,
      refreshLog,
      t,
    ],
  );

  const pullCurrentBranch = useCallback(
    async (branch: string) => {
      if (!hasGitContext || branchActionInProgress) return;
      setBranchActionInProgress(`pull:${branch}`);
      const result = effectiveThreadId
        ? await api.pull(effectiveThreadId, 'ff-only')
        : await api.projectPull(projectModeId!, 'ff-only');
      if (result.isOk()) {
        toast.success(t('review.pullSuccess', 'Pulled successfully'));
      } else {
        toast.error(
          t('review.pullFailed', {
            message: result.error.message,
            defaultValue: `Pull failed: ${result.error.message}`,
          }),
        );
      }
      setBranchActionInProgress(null);
      refreshGitStatus();
      refreshLog();
    },
    [
      hasGitContext,
      branchActionInProgress,
      effectiveThreadId,
      projectModeId,
      refreshGitStatus,
      refreshLog,
      t,
    ],
  );

  if (!hasGitContext) {
    return <EmptyState title={t('review.noProject', 'Select a project to view history')} />;
  }

  return (
    <div
      className="flex h-full w-full min-w-0 flex-col overflow-hidden"
      data-testid="commit-graph-tab"
    >
      <GraphToolbar
        logLoading={logLoading}
        allBranches={allBranches}
        commitCount={entries.length}
        onRefresh={refreshLog}
        onToggleAllBranches={() => setAllBranches((v) => !v)}
      />

      <div className="border-sidebar-border bg-background border-b px-2 py-1">
        <SearchBar
          query={searchQuery}
          onQueryChange={setSearchQuery}
          totalMatches={displayEntries.length}
          loading={isFiltering && logLoading}
          onClose={isFiltering ? clearSearch : undefined}
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
          firstRow={layout.rows[0]}
          laneCount={laneCount}
          gutterWidth={gutterWidth}
          rowHeight={baseRowH}
        />
      )}

      <div className="flex flex-1 flex-col overflow-y-auto" ref={scrollRef}>
        {logLoading && entries.length === 0 ? (
          <LoadingState testId="graph-loading" label={t('review.loadingLog', 'Loading commits…')} />
        ) : logErrorMessage ? (
          <EmptyState
            testId="graph-load-error"
            icon={AlertTriangle}
            title={t('review.logLoadFailed', 'Failed to load history')}
            description={logErrorMessage}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={refreshLog}
                className="gap-1.5"
                data-testid="graph-retry"
              >
                <RefreshCw className="icon-xs" />
                {t('common.retry', 'Retry')}
              </Button>
            }
          />
        ) : displayEntries.length === 0 ? (
          isFiltering ? (
            <EmptyState
              icon={Search}
              title={t('graph.noMatches', 'No commits match your search')}
            />
          ) : (
            <EmptyState icon={GitCommit} title={t('review.noCommits', 'No commits yet')} />
          )
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
            }}
          >
            <RebaseCopyLinksOverlay
              links={rebaseCopyLinks}
              entries={displayEntries}
              layoutRows={layout.rows}
              gutterWidth={gutterWidth}
              rowHeightFor={rowHeightFor}
            />
            {virtualItems.map((virtualRow) => {
              if (virtualRow.index >= displayEntries.length) {
                return (
                  <div
                    key="__sentinel__"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: baseRowH,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    className="flex items-center justify-center"
                  >
                    <LoadingState
                      fill={false}
                      layout="inline"
                      size="compact"
                      testId="graph-loading-more"
                      label={t('history.loadingMore', 'Loading more…')}
                    />
                  </div>
                );
              }
              const entry = displayEntries[virtualRow.index];
              return (
                <GraphCommitRow
                  key={entry.hash}
                  entry={entry}
                  graphRow={layout.rows[virtualRow.index]}
                  laneCount={laneCount}
                  gutterWidth={gutterWidth}
                  selected={selectedHash === entry.hash}
                  avatarUrl={
                    githubAvatarBySha.get(entry.hash) ?? avatarByEmail.get(entry.authorEmail)
                  }
                  committerAvatarUrl={avatarByEmail.get(entry.committerEmail)}
                  githubBrowseBaseUrl={githubBrowseBaseUrl}
                  effectiveThreadId={effectiveThreadId}
                  projectModeId={projectModeId}
                  onAfterAction={refreshLog}
                  branchSummaryByName={branchSummaryByName}
                  branchActionInProgress={branchActionInProgress}
                  onPushBranch={pushBranch}
                  onPullCurrentBranch={pullCurrentBranch}
                  rebaseEvents={rebaseEventsByHash.get(entry.hash) ?? []}
                  onSelectRebaseEvent={setSelectedRebaseEvent}
                  forkedFromRefLabel={
                    forkedFromRefLabelByHash.get(entry.hash) ??
                    rebaseParentRefLabelByHash.get(entry.hash) ??
                    null
                  }
                  parentLabel={parentLabelByHash.get(entry.hash) ?? null}
                  unpushed={unpushed.has(entry.hash)}
                  unpulled={unpulled.has(entry.hash) || inferredUnpulled.has(entry.hash)}
                  connectToWip={!!wipStatus && virtualRow.index === 0}
                  searchQuery={searchQuery}
                  transform={virtualRow.start}
                  rowHeight={rowHeightFor(entry)}
                  onSelect={() => setSelectedHash(selectedHash === entry.hash ? null : entry.hash)}
                />
              );
            })}
          </div>
        )}
      </div>

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

function nodeYForRow(entry: Pick<GraphEntry, 'refs'>, rowHeight: number): number {
  if (entry.refs.length === 0) return rowHeight / 2;
  const chipLineH = META_PX + 5;
  const titleLineH = Math.round(TITLE_PX * 1.5);
  const refsContentH = chipLineH + 6 + titleLineH;
  return (rowHeight - refsContentH) / 2 + chipLineH / 2;
}

function RebaseCopyLinksOverlay({
  links,
  entries,
  layoutRows,
  gutterWidth,
  rowHeightFor,
}: {
  links: RebaseCopyLink[];
  entries: GraphEntry[];
  layoutRows: GraphRow[];
  gutterWidth: number;
  rowHeightFor: (entry: GraphEntry) => number;
}) {
  const markerId = useId();
  if (links.length === 0) return null;

  let nextTop = 0;
  const rowsByHash = new Map<
    string,
    {
      top: number;
      nodeY: number;
      lane: number;
    }
  >();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const row = layoutRows[index];
    const height = rowHeightFor(entry);
    if (row) {
      rowsByHash.set(entry.hash, {
        top: nextTop,
        nodeY: nodeYForRow(entry, height),
        lane: row.commitLane,
      });
    }
    nextTop += height;
  }

  const visibleLinks: Array<{
    link: RebaseCopyLink;
    source: { top: number; nodeY: number; lane: number };
    target: { top: number; nodeY: number; lane: number };
  }> = [];
  for (const link of links) {
    const source = rowsByHash.get(link.sourceHash);
    const target = rowsByHash.get(link.targetHash);
    if (source && target) visibleLinks.push({ link, source, target });
  }
  if (visibleLinks.length === 0) return null;

  const maxRailLane = visibleLinks.reduce((maxLane, { source, target }) => {
    const railLane = rebaseCopyLinkRailLane({
      sourceLane: source.lane,
      targetLane: target.lane,
    });
    return Math.max(maxLane, railLane);
  }, 0);
  const maxRailX = rebaseCopyLinkRailX({
    laneGutterWidth: maxRailLane * LANE_WIDTH,
    railWidth: REBASE_LINK_RAIL_WIDTH,
  });
  const width = Math.max(gutterWidth + 12, maxRailX + 12, LANE_WIDTH * 4);

  return (
    <svg
      className="pointer-events-none absolute top-0 left-0 z-20"
      style={{ width, height: nextTop, overflow: 'visible' }}
      width={width}
      height={nextTop}
      aria-hidden="true"
      data-testid="graph-rebase-copy-links"
    >
      <defs>
        <marker
          id={markerId}
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M 0 0 L 6 3 L 0 6 z" fill="var(--terminal-yellow)" />
        </marker>
      </defs>
      {visibleLinks.map(({ link, source, target }) => {
        const railLane = rebaseCopyLinkRailLane({
          sourceLane: source.lane,
          targetLane: target.lane,
        });
        const railX = rebaseCopyLinkRailX({
          laneGutterWidth: railLane * LANE_WIDTH,
          railWidth: REBASE_LINK_RAIL_WIDTH,
        });
        const y2 = target.top + target.nodeY;
        const x1 = rebaseLinkNodeEdgeX(source.lane);
        const y1 = source.top + source.nodeY;
        const x2 = rebaseLinkNodeEdgeX(target.lane);
        return (
          <g key={`${link.event.id}:${link.sourceHash}:${link.targetHash}`}>
            <path
              d={roundedRebaseCopyLinkPath({
                sourceX: x1,
                sourceY: y1,
                targetX: x2,
                targetY: y2,
                railX,
              })}
              fill="none"
              stroke="var(--terminal-yellow)"
              strokeWidth={1.4}
              strokeDasharray="3 3"
              strokeLinecap="round"
              strokeLinejoin="round"
              markerEnd={`url(#${markerId})`}
              opacity={0.9}
            />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Resolve an avatar URL per author email (GitHub `.png` for `noreply` addresses,
 * else a Gravatar identicon). Works without a GitHub token and for local commits,
 * so every node can show a photo. Results are cached for the process lifetime.
 */
function useEmailAvatars(entries: GraphEntry[]): Map<string, string> {
  const [avatarByEmail, setAvatarByEmail] = useState<Map<string, string>>(
    () => new Map(emailAvatarCache),
  );
  useEffect(() => {
    const emails = [
      ...new Set(
        entries
          .flatMap((e) => [e.authorEmail, e.committerEmail])
          .filter((email): email is string => !!email),
      ),
    ];
    const missing = emails.filter((e) => !avatarByEmail.has(e));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(missing.map(async (email) => [email, await authorAvatarUrl(email)] as const)).then(
      (pairs) => {
        if (cancelled) return;
        const resolved = pairs.filter((p): p is [string, string] => !!p[1]);
        if (resolved.length === 0) return;
        setAvatarByEmail((prev) => {
          const next = new Map(prev);
          for (const [email, url] of resolved) {
            next.set(email, url);
            emailAvatarCache.set(email, url);
          }
          return next;
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [entries, avatarByEmail]);
  return avatarByEmail;
}

/** Toolbar: refresh, all-branches toggle, and a commit counter. */
function GraphToolbar({
  logLoading,
  allBranches,
  commitCount,
  onRefresh,
  onToggleAllBranches,
}: {
  logLoading: boolean;
  allBranches: boolean;
  commitCount: number;
  onRefresh: () => void;
  onToggleAllBranches: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="border-sidebar-border bg-background flex items-center gap-1 border-b px-2 py-1">
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
        onClick={onRefresh}
        disabled={logLoading}
        data-testid="graph-refresh"
      >
        <RefreshCw className={cn('icon-base', logLoading && 'animate-spin')} />
      </Button>
      <Button
        variant={allBranches ? 'secondary' : 'ghost'}
        size="sm"
        className="h-8 gap-1 px-2 text-xs"
        onClick={onToggleAllBranches}
        data-testid="graph-toggle-all-branches"
      >
        <GitBranch className="icon-base" />
        {t('graph.allBranches', 'All branches')}
      </Button>
      <span className="text-muted-foreground ml-auto text-[10px]">
        {t('graph.commitCount', {
          count: commitCount,
          defaultValue: `${commitCount} commits`,
        })}
      </span>
    </div>
  );
}

/**
 * Synthetic top-of-graph row for the working tree's uncommitted changes
 * (GitKraken-style "WIP" node). Pinned above the scroll list and shown only when
 * the tree is dirty; clicking it jumps to the Changes tab. Draws a hollow dashed
 * node in HEAD's lane with a dashed connector heading down toward the tip.
 */
export function GraphWipRow({
  status,
  firstRow,
  laneCount,
  gutterWidth,
  rowHeight,
}: {
  status: NonNullable<ReturnType<typeof useWorkingTreeStatus>['status']>;
  firstRow: GraphRow | undefined;
  laneCount: number;
  gutterWidth: number;
  rowHeight: number;
}) {
  const { t } = useTranslation();
  const setReviewSubTab = useUIStore((s) => s.setReviewSubTab);
  const lane = Math.min(firstRow?.commitLane ?? 0, Math.max(0, laneCount - 1));
  const cx = lane * LANE_WIDTH + LANE_WIDTH / 2;
  const cy = rowHeight / 2;
  const stroke = graphLanePastel(firstRow?.nodeColor ?? 0);
  const r = Math.min(LANE_WIDTH / 2, Math.max(5, Math.round(rowHeight * 0.15)));
  return (
    <button
      type="button"
      onClick={() => setReviewSubTab('changes')}
      style={{ height: rowHeight }}
      className="hover:bg-accent/50 flex w-full shrink-0 cursor-pointer items-center gap-2 overflow-hidden pr-2 pl-3 text-left transition-colors"
      data-testid="graph-wip-row"
    >
      <div style={{ width: gutterWidth }} className="shrink-0 self-stretch">
        <svg
          width={gutterWidth}
          height={rowHeight}
          style={{ width: gutterWidth, height: rowHeight, overflow: 'visible' }}
          aria-hidden="true"
        >
          {/* Dashed connector heading down toward the HEAD commit below. */}
          <line
            x1={cx}
            y1={cy}
            x2={cx}
            y2={rowHeight}
            stroke={stroke}
            strokeWidth={1.6}
            strokeDasharray="2 2"
          />
          {/* Hollow dashed node = work not yet committed. */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="hsl(var(--background))"
            stroke={stroke}
            strokeWidth={1.6}
            strokeDasharray="2 2"
          />
        </svg>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
        <span className="text-foreground truncate text-xs leading-tight font-medium">
          {t('graph.uncommittedChanges', 'Uncommitted changes')}
        </span>
        <DiffStats
          linesAdded={status.linesAdded}
          linesDeleted={status.linesDeleted}
          dirtyFileCount={status.dirtyFileCount}
          size="xs"
        />
      </div>
    </button>
  );
}

/** One commit row: graph gutter + subject/refs + author avatar, hash, link. */
function GraphCommitRow({
  entry,
  graphRow,
  laneCount,
  gutterWidth,
  selected,
  avatarUrl,
  committerAvatarUrl,
  githubBrowseBaseUrl,
  effectiveThreadId,
  projectModeId,
  onAfterAction,
  branchSummaryByName,
  branchActionInProgress,
  onPushBranch,
  onPullCurrentBranch,
  rebaseEvents,
  onSelectRebaseEvent,
  forkedFromRefLabel,
  parentLabel,
  unpushed,
  unpulled,
  connectToWip,
  searchQuery,
  transform,
  rowHeight,
  onSelect,
}: {
  entry: GraphEntry;
  graphRow: GraphRow | undefined;
  laneCount: number;
  gutterWidth: number;
  selected: boolean;
  avatarUrl: string | undefined;
  committerAvatarUrl: string | undefined;
  githubBrowseBaseUrl: string | null;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  onAfterAction: () => void;
  branchSummaryByName: ReadonlyMap<string, GraphBranchSummary>;
  branchActionInProgress: string | null;
  onPushBranch: (branch: string) => void;
  onPullCurrentBranch: (branch: string) => void;
  rebaseEvents: GitRebaseReflogEventDTO[];
  onSelectRebaseEvent: (event: GitRebaseReflogEventDTO) => void;
  forkedFromRefLabel: string | null;
  parentLabel: GraphNodeParentLabel | null;
  unpushed: boolean;
  unpulled: boolean;
  /** HEAD row with a dirty tree → draw the dashed stub up to the WIP node. */
  connectToWip: boolean;
  /** Active filter query — highlights matching substrings in the title & refs. */
  searchQuery: string;
  transform: number;
  rowHeight: number;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  // Keep the kebab pinned (and the time hidden) while its dropdown is open.
  const [menuOpen, setMenuOpen] = useState(false);

  // Serve the node avatar from the short-TTL blob cache so scrolling the
  // virtualized list doesn't re-hit GitHub for the same image (avoids 429s).
  const cachedAvatarUrl = useCachedAvatar(avatarUrl);
  const hasDistinctCommitter = hasDistinctCommitterIdentity(entry);
  const cachedCommitterAvatarUrl = useCachedAvatar(
    hasDistinctCommitter ? committerAvatarUrl : undefined,
  );

  // Render branch/tag refs with the same powerline component used across the
  // app (sidebar, kanban, …). The chip color derives from the commit's own
  // graph-lane color, then `pastelize()`'d into the same soft pastel range as
  // the project-selection palette — so the chip reads as a project-style pastel
  // while still sharing its lane's hue (it matches the gutter line). Branches on
  // different lanes get different hues. Multiple refs on one commit darken
  // progressively (same degraded-color approach as the sidebar project
  // powerline): first chip = the pastel, each next a shade darker.
  //
  // GitKraken-style ref folding: when a local branch and its remote-tracking
  // branch (`feat/x` + `origin/feat/x`) decorate the SAME commit, they're in
  // sync, so we collapse the pair into ONE chip. Each chip carries a SINGLE
  // icon that encodes its state (no redundant branch+cloud pairing): a synced
  // branch shows `CloudCheck` (tracked & up to date), a local-only branch shows
  // `Monitor` (lives only on this machine), a lone remote-tracking branch shows
  // `Cloud`, a tag shows `Tag`.
  const lanePastel = graphLanePastel(graphRow?.nodeColor ?? 0);
  const foldedRefs = useMemo(
    () => foldGraphRefs(entry.refs, entry.headBranch),
    [entry.refs, entry.headBranch],
  );
  const pullRequestLinks = useMemo(() => {
    const seen = new Set<string>();
    return foldedRefs.flatMap((r) => {
      if (!r.pullRequest) return [];
      const key = r.pullRequest.url || String(r.pullRequest.number);
      if (seen.has(key)) return [];
      seen.add(key);
      return [r.pullRequest];
    });
  }, [foldedRefs]);
  // Local-only branch tips on this commit — `local` folded refs with no synced
  // remote (i.e. the ones rendered with the `Monitor` glyph). These are exactly
  // the branches that have something unpushed, so they drive the menu's "Push …
  // to origin" entries (Option B: push only surfaces on an unpushed branch tip).
  // The detached-HEAD pseudo-ref isn't a branch, so it's excluded.
  const pushableBranches = useMemo(
    () =>
      foldedRefs
        .filter((r) => r.kind === 'local' && !r.syncedRemote && r.name !== 'HEAD')
        .map((r) => r.name),
    [foldedRefs],
  );
  const targetBranches = useMemo(
    () =>
      foldedRefs
        .filter((r) => r.kind === 'local' && r.name !== 'HEAD')
        .map((r) => r.name)
        .filter((branch) => !branchSummaryByName.get(branch)?.isCurrent),
    [branchSummaryByName, foldedRefs],
  );

  const githubUrl = githubCommitUrlForRemoteCommit(githubBrowseBaseUrl, entry.hash, unpushed);
  const commitTime = useMemo(
    () => <GraphCommitTime relativeDate={entry.relativeDate} />,
    [entry.relativeDate],
  );

  // When the row carries a branch/tag powerline, raise the node to the chip's
  // vertical center so the leader line is a straight horizontal that exits the
  // side of the avatar (instead of an L from the row-centered node). The chip
  // sits in a (META_PX + 5) line above a 6px gap and the title; since the info
  // column is centered, derive its center from the same constants the row-height
  // math uses, so it scales with the font-size setting.
  // The chip line and title line get EXPLICIT heights below so this arithmetic
  // matches the rendered DOM exactly — otherwise line-height/padding rounding
  // leaves the leader line a couple px off the chip's true center.
  const hasRefs = foldedRefs.length > 0;
  const chipLineH = META_PX + 5;
  const titleLineH = Math.round(TITLE_PX * 1.5);
  const chipCenterY = nodeYForRow(entry, rowHeight);
  const nodeYFrac = hasRefs ? chipCenterY / rowHeight : 0.5;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: rowHeight,
        transform: `translateY(${transform}px)`,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          'group relative flex h-full w-full cursor-pointer items-center gap-2 overflow-hidden pl-3 pr-2 text-left transition-colors',
          selected ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-accent/50',
        )}
        data-testid={`graph-commit-${entry.shortHash}`}
      >
        {/* Leader line tying the branch/tag chip to its commit node, so it's
            unambiguous which node the powerline belongs to. The node is raised to
            the chip's level (see nodeYFrac), so this is a straight horizontal line
            exiting the side of the avatar, in the node's lane color. Drawn first so
            it sits behind the node disc and the chip. */}
        {hasRefs &&
          graphRow &&
          (() => {
            // px geometry from the row's padding-box origin (absolute inset-0).
            // Horizontal: pl-3 (12) + gutter + gap-2 (8) + info pl-1 (4).
            const avatarR = Math.min(LANE_WIDTH / 2, Math.max(6, Math.round(rowHeight * 0.15)));
            const nodeX = 12 + graphRow.commitLane * LANE_WIDTH + LANE_WIDTH / 2;
            const chipLeftX = 12 + gutterWidth + 8 + 4;
            return (
              <svg
                className="pointer-events-none absolute inset-0"
                style={{ overflow: 'visible' }}
                aria-hidden="true"
              >
                <line
                  x1={nodeX + avatarR}
                  y1={chipCenterY}
                  x2={chipLeftX}
                  y2={chipCenterY}
                  stroke={lanePastel}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                />
              </svg>
            );
          })()}
        {/* Layout: graph | commit info, with branch/tag chips above the title. */}
        {graphRow &&
          (() => {
            // Anchor the identity tooltip to the avatar node itself, not the whole
            // gutter — otherwise the tooltip centers over the (possibly wide)
            // multi-lane gutter and reads as detached from the avatar. The node
            // sits at `commitLane`'s center; its diameter mirrors GraphGutter's
            // avatar sizing so the trigger overlays it precisely.
            const nodeCenterX = graphRow.commitLane * LANE_WIDTH + LANE_WIDTH / 2;
            const avatarDiameter =
              2 * Math.min(LANE_WIDTH / 2, Math.max(6, Math.round(rowHeight * 0.15)));
            const nodeHitboxSize = hasDistinctCommitter ? avatarDiameter + 8 : avatarDiameter;
            return (
              <div style={{ width: gutterWidth }} className="relative shrink-0 self-stretch">
                <GraphGutter
                  row={graphRow}
                  laneCount={laneCount}
                  height={rowHeight}
                  avatarUrl={cachedAvatarUrl}
                  authorName={entry.author}
                  committerAvatarUrl={cachedCommitterAvatarUrl}
                  committerName={hasDistinctCommitter ? entry.committer : undefined}
                  connectUp={connectToWip}
                  nodeYFrac={nodeYFrac}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      aria-hidden
                      className="absolute -translate-x-1/2 -translate-y-1/2"
                      style={{
                        left: nodeCenterX,
                        top: nodeYFrac * rowHeight,
                        width: nodeHitboxSize,
                        height: nodeHitboxSize,
                      }}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <div className="flex flex-col gap-0.5">
                      <span>
                        {t('graph.nodeAuthor', {
                          author: entry.author,
                          defaultValue: `Author: ${entry.author}`,
                        })}
                      </span>
                      {hasDistinctCommitter ? (
                        <span>
                          {t('graph.nodeCommitter', {
                            committer: entry.committer,
                            defaultValue: `Committed by: ${entry.committer}`,
                          })}
                        </span>
                      ) : null}
                      {forkedFromRefLabel ? (
                        <span>
                          {t('graph.nodeBranchedFrom', {
                            branch: forkedFromRefLabel,
                            defaultValue: `Branched from: ${forkedFromRefLabel}`,
                          })}
                        </span>
                      ) : null}
                      {parentLabel ? (
                        <>
                          <span>
                            {t('graph.nodeParent', {
                              parent: parentLabel.commit,
                              defaultValue: `Parent: ${parentLabel.commit}`,
                            })}
                          </span>
                          {parentLabel.branchLabels.length > 0 ? (
                            <ul className="list-disc space-y-0.5 pl-4">
                              {parentLabel.branchLabels.map((branch) => (
                                <Tooltip key={branch}>
                                  <TooltipTrigger asChild>
                                    <li>{middleTruncate(branch, PARENT_BRANCH_LABEL_MAX_CHARS)}</li>
                                  </TooltipTrigger>
                                  <TooltipContent className="max-w-[min(28rem,calc(100vw-2rem))] font-mono break-all">
                                    {branch}
                                  </TooltipContent>
                                </Tooltip>
                              ))}
                            </ul>
                          ) : null}
                        </>
                      ) : null}
                      {unpushed && <span>{t('history.unpushed', 'Not pushed')}</span>}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })()}
        {/* Commit info: title line, optional branch/tag chips above it. */}
        <div className="flex min-w-0 flex-1 flex-col justify-center pl-1">
          {/* Branch/tag chips on their own line above the commit title. */}
          {foldedRefs.length > 0 && (
            <div
              className="mb-1.5 flex min-w-0 shrink-0 items-center overflow-hidden"
              style={{ height: chipLineH }}
            >
              {/* Branches on a commit are siblings, not a hierarchy — render
                  them as separate pills (`chips`) rather than connected powerline
                  chevrons, which read as one continuous path when two branch tips
                  share a commit. A folded local+remote pair is already ONE chip,
                  so distinct chips here always mean distinct branches/tags. */}
              <GraphRefChips
                refs={foldedRefs}
                branchSummaryByName={branchSummaryByName}
                actionInProgress={branchActionInProgress}
                color={lanePastel}
                searchQuery={searchQuery}
                onPushBranch={onPushBranch}
                onPullCurrentBranch={onPullCurrentBranch}
              />
              {pullRequestLinks.map((pr) => (
                <PRBadge
                  key={pr.url}
                  prNumber={pr.number}
                  prState={pr.state}
                  prUrl={pr.url}
                  size="compact"
                  className="ml-1"
                  data-testid={`graph-pr-badge-${pr.number}`}
                />
              ))}
            </div>
          )}
          {/* Same Tailwind classes as the History list (`CommitListPanel`) so the
              title/meta sizes are rem-based and identical across every tab. */}
          <div
            className="flex w-full min-w-0 shrink-0 items-center gap-1.5"
            style={{ height: titleLineH }}
          >
            <HighlightText
              text={entry.message}
              query={searchQuery}
              className="text-foreground min-w-0 flex-1 truncate text-xs leading-tight font-medium"
            />
            <GraphCommitSyncMarkers
              unpushed={unpushed}
              unpulled={unpulled}
              shortHash={entry.shortHash}
              className="ml-auto"
            />
          </div>
        </div>
        {/* Time ↔ kebab swap (same component as the sidebar thread rows): the
            relative date rests here and the per-commit actions menu reveals on
            hover, so the two share one cell instead of each reserving width. */}
        <HoverTimeMenu
          time={commitTime}
          timeClassName="text-muted-foreground text-[10px]"
          open={menuOpen}
          className="min-w-12 self-center"
        >
          <CommitActionsMenu
            hash={entry.hash}
            shortHash={entry.shortHash}
            githubUrl={githubUrl}
            effectiveThreadId={effectiveThreadId}
            projectModeId={projectModeId}
            localBranches={pushableBranches}
            targetBranches={targetBranches}
            rebaseEvents={rebaseEvents}
            onSelectRebaseEvent={onSelectRebaseEvent}
            onAfterAction={onAfterAction}
            onOpenChange={setMenuOpen}
            triggerClassName="text-muted-foreground hover:text-foreground"
          />
        </HoverTimeMenu>
      </div>
    </div>
  );
}

function RebaseEventDialog({
  event,
  onClose,
}: {
  event: GitRebaseReflogEventDTO | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={!!event} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[80vh] max-w-2xl overflow-hidden p-0"
        data-testid="rebase-event-dialog"
      >
        {event &&
          (() => {
            const commitPairs = event.commitPairs ?? [];
            const replayedCount = commitPairs.length || event.commitHashes.length;
            return (
              <div className="flex max-h-[80vh] min-h-0 flex-col">
                <div className="border-sidebar-border border-b px-4 py-3">
                  <DialogTitle className="text-sm leading-tight font-semibold">
                    {t('graph.rebaseDetailsTitle', 'Rebase details')}
                  </DialogTitle>
                  <DialogDescription className="text-muted-foreground mt-1 text-xs">
                    {event.completed
                      ? t('graph.rebaseDetailsDescription', {
                          count: replayedCount,
                          defaultValue: `${replayedCount} commits replayed from local reflog`,
                        })
                      : t(
                          'graph.rebaseDetailsIncomplete',
                          'Partial rebase details from local reflog',
                        )}
                  </DialogDescription>
                </div>

                <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-xs">
                  <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2">
                    <dt className="text-muted-foreground">{t('graph.rebaseBranch', 'Branch')}</dt>
                    <dd className="font-mono">{event.branch ?? '-'}</dd>
                    <dt className="text-muted-foreground">{t('graph.rebaseOnto', 'Onto')}</dt>
                    <dd className="font-mono">{event.onto ?? '-'}</dd>
                    <dt className="text-muted-foreground">{t('graph.rebaseStarted', 'Started')}</dt>
                    <dd className="font-mono">{event.startedAt ?? '-'}</dd>
                    <dt className="text-muted-foreground">
                      {t('graph.rebaseFinished', 'Finished')}
                    </dt>
                    <dd className="font-mono">{event.finishedAt ?? '-'}</dd>
                    <dt className="text-muted-foreground">{t('graph.rebaseBefore', 'Before')}</dt>
                    <dd className="font-mono">{event.startShortHash ?? '-'}</dd>
                    <dt className="text-muted-foreground">{t('graph.rebaseAfter', 'After')}</dt>
                    <dd className="font-mono">{event.finishShortHash ?? '-'}</dd>
                  </dl>

                  {commitPairs.length > 0 && (
                    <div className="border-sidebar-border mt-4 border-t pt-3">
                      <div className="text-muted-foreground mb-2 text-[10px] font-medium uppercase">
                        {t('graph.rebaseCommitPairs', 'Rewritten commits')}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {commitPairs.map((pair) => (
                          <div
                            key={`${pair.originalHash}:${pair.rebasedHash}`}
                            className="bg-muted/40 grid grid-cols-[80px_16px_80px_minmax(0,1fr)] items-center gap-2 rounded px-2 py-1.5"
                          >
                            <span className="font-mono">{pair.originalShortHash}</span>
                            <span className="text-muted-foreground">→</span>
                            <span className="font-mono">{pair.rebasedShortHash}</span>
                            <span className="truncate">{pair.subject}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="border-sidebar-border mt-4 border-t pt-3">
                    <div className="text-muted-foreground mb-2 text-[10px] font-medium uppercase">
                      {t('graph.rebaseSteps', 'Reflog steps')}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {event.steps.map((step) => (
                        <div
                          key={`${step.selector}:${step.action}:${step.hash}`}
                          className="bg-muted/40 grid grid-cols-[72px_88px_minmax(0,1fr)] gap-2 rounded px-2 py-1.5"
                        >
                          <span className="font-mono">{step.shortHash}</span>
                          <span className="text-muted-foreground">{step.action}</span>
                          <span className="truncate">{step.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
      </DialogContent>
    </Dialog>
  );
}

export function GraphCommitTime({ relativeDate }: { relativeDate: string }) {
  return <span>{shortRelativeDate(relativeDate)}</span>;
}

export function GraphCommitSyncMarkers({
  unpushed,
  unpulled = false,
  shortHash,
  className,
}: {
  unpushed: boolean;
  unpulled?: boolean;
  shortHash: string;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!unpushed && !unpulled) return null;

  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1', className)}>
      {unpushed && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={t('history.unpushed', 'Not pushed')}
              className="inline-flex shrink-0"
              data-testid={`graph-unpushed-${shortHash}`}
            >
              <ArrowUpCircle
                className="icon-sm text-primary [&_path]:stroke-primary-foreground [&_circle]:fill-current"
                data-testid={`graph-unpushed-icon-${shortHash}`}
                strokeWidth={3}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{t('history.unpushed', 'Not pushed')}</TooltipContent>
        </Tooltip>
      )}
      {unpulled && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={t('history.unpulled', 'Not pulled')}
              className="inline-flex shrink-0"
              data-testid={`graph-unpulled-${shortHash}`}
            >
              <ArrowDownCircle
                className="icon-sm text-primary [&_path]:stroke-primary-foreground [&_circle]:fill-current"
                data-testid={`graph-unpulled-icon-${shortHash}`}
                strokeWidth={3}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{t('history.unpulled', 'Not pulled')}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
