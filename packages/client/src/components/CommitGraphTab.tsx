import { useVirtualizer } from '@tanstack/react-virtual';
import { Cloud, CloudCheck, GitBranch, GitCommit, RefreshCw, Search, Tag } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { CommitActionsMenu } from '@/components/commit-graph/CommitActionsMenu';
import { GraphGutter, LANE_WIDTH } from '@/components/commit-graph/GraphGutter';
import { CommitDetailDialog } from '@/components/commit-history/CommitDetailDialog';
import { DiffStats } from '@/components/DiffStats';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { HighlightText } from '@/components/ui/highlight-text';
import { LoadingState } from '@/components/ui/loading-state';
import { PowerlineBar, type PowerlineSegmentData } from '@/components/ui/powerline-bar';
import { darkenHex } from '@/components/ui/project-chip';
import { SearchBar } from '@/components/ui/search-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useWorkingTreeStatus } from '@/hooks/use-working-tree-status';
import { api } from '@/lib/api';
import type { GraphRefDTO } from '@/lib/api/git';
import { authorAvatarUrl } from '@/lib/author-avatar';
import { useCachedAvatar } from '@/lib/avatar-cache';
import { createClientLogger } from '@/lib/client-logger';
import { computeGraphRows, type GraphRow } from '@/lib/git-graph-lanes';
import { commitMatchesQuery } from '@/lib/git-history-search';
import {
  githubBrowseBaseUrl as resolveGithubBrowseBaseUrl,
  githubCommitUrl,
} from '@/lib/github-url';
import { graphLanePastel } from '@/lib/graph-colors';
import { foldGraphRefs } from '@/lib/graph-refs';
import { metric } from '@/lib/telemetry';
import { shortRelativeDate } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useThreadProjectId } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';
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
  relativeDate: string;
  message: string;
  body: string;
  parentHashes: string[];
  refs: GraphRefDTO[];
  /** Checked-out branch, set only on the commit HEAD points at (else null). */
  headBranch: string | null;
}

const PAGE_SIZE = 80;
// The title/meta text is rendered with the SAME Tailwind classes as the History
// list (`text-xs` + `text-[10px]`) so the font is identical across every
// Review-pane tab. These px values are only used to *estimate* row heights for
// the virtualizer — `text-xs` resolves to ~10.5px at the app's 14px rem base,
// and `text-[10px]` is an absolute 10px.
const TITLE_PX = 10.5;
const META_PX = 10;
const MAX_GUTTER_LANES = 12;
// Upper bound on how many commits the active-filter background pager will pull
// in, so filtering a huge repo can't page the entire history into memory.
const FILTER_MAX_SCAN = 2000;

interface CommitGraphTabProps {
  visible?: boolean;
}

/**
 * Branch-graph view of git history. Separate from {@link CommitHistoryTab}
 * (the flat list) — this one renders a GitKraken-style lane graph on the left
 * of each commit using `git log --all --date-order` data (parents + refs).
 * Per-commit affordances mirror the History list: GitHub avatar, copy-hash, an
 * external link to the commit, and an unpushed marker. Click a commit to open
 * the shared {@link CommitDetailDialog}.
 */
export function CommitGraphTab({ visible }: CommitGraphTabProps) {
  const { t } = useTranslation();
  // Typography is fixed to match the History list so the font is identical
  // across every Review-pane tab (see TITLE_PX / META_PX above).
  const titlePx = TITLE_PX;
  const metaPx = META_PX;
  // Variable row heights: the title + time share one line, so ref-less rows are a
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
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const effectiveThreadId = useThreadStore((s) => s.selectedThreadId) || undefined;
  const projectModeId = !effectiveThreadId ? selectedProjectId : null;
  const threadProjectId = useThreadProjectId();
  const hasGitContext = !!(effectiveThreadId || projectModeId);

  const [entries, setEntries] = useState<GraphEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [allBranches, setAllBranches] = useState(true);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [unpushed, setUnpushed] = useState<Set<string>>(new Set());
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
        const { entries: next, hasMore: more, unpushedHashes } = result.value;
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
        metric('git.graph_log.loaded', performance.now() - started, {
          attributes: { count: String(next.length), append: String(append) },
        });
        out = { entries: merged, hasMore: more };
      } else if (result.error.message !== 'Request aborted') {
        log.warn('graph-log load failed', { error: result.error.message });
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
    setUnpushed(new Set());
    // Drop the filter query — it belongs to the old context.
    setSearchQuery('');
    if (visible && hasGitContext) {
      loadedRef.current = true;
      loadLog(0, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only on context change
  }, [gitContextKey]);

  // Load on first reveal if the tab mounted while hidden.
  useEffect(() => {
    if (visible && hasGitContext && !loadedRef.current) {
      loadedRef.current = true;
      loadLog(0, false);
    }
  }, [visible, hasGitContext, loadLog]);

  // Resolve the GitHub browse base URL so commit hashes can deep-link.
  const remoteCheckProjectId = projectModeId ?? threadProjectId ?? null;
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
  const ghProjectId = projectModeId ?? threadProjectId ?? null;
  useEffect(() => {
    if (!ghProjectId || entries.length === 0) return;
    const firstMissing = entries.find(
      (e) => !githubAvatarBySha.has(e.hash) && !anchoredShasRef.current.has(e.hash),
    );
    if (!firstMissing) return;
    anchoredShasRef.current.add(firstMissing.hash);
    let cancelled = false;
    api
      .githubCommitAuthors(ghProjectId, { sha: firstMissing.hash, per_page: 100 })
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

  const layout = useMemo(() => {
    // While filtering, the surviving commits are no longer contiguous in topo
    // order, so the lane graph would render as a meaningless staircase. Show a
    // flat list instead: one standalone node per row, no connecting rails.
    if (isFiltering) {
      return {
        rows: displayEntries.map(() => ({ commitLane: 0, nodeColor: 0, segments: [] })),
        laneCount: 1,
      };
    }
    return computeGraphRows(
      displayEntries.map((e) => ({ hash: e.hash, parentHashes: e.parentHashes })),
    );
  }, [displayEntries, isFiltering]);
  const laneCount = Math.min(layout.laneCount, MAX_GUTTER_LANES);
  const gutterWidth = laneCount * LANE_WIDTH;

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
          <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
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
                  githubBrowseBaseUrl={githubBrowseBaseUrl}
                  effectiveThreadId={effectiveThreadId}
                  projectModeId={projectModeId}
                  onAfterAction={refreshLog}
                  unpushed={unpushed.has(entry.hash)}
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
    </div>
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
    const emails = [...new Set(entries.map((e) => e.authorEmail).filter(Boolean))];
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
        size="icon"
        className="size-6"
        onClick={onRefresh}
        disabled={logLoading}
        data-testid="graph-refresh"
      >
        <RefreshCw className={cn('icon-xs', logLoading && 'animate-spin')} />
      </Button>
      <Button
        variant={allBranches ? 'secondary' : 'ghost'}
        size="sm"
        className="h-6 gap-1 px-2 text-xs"
        onClick={onToggleAllBranches}
        data-testid="graph-toggle-all-branches"
      >
        <GitBranch className="icon-xs" />
        {t('graph.allBranches', 'All branches')}
      </Button>
      <span className="text-muted-foreground ml-auto text-[10px]">
        {t('graph.commitCount', { count: commitCount, defaultValue: `${commitCount} commits` })}
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
function GraphWipRow({
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
      className="border-sidebar-border/60 hover:bg-accent/50 flex w-full shrink-0 cursor-pointer items-center gap-2 overflow-hidden border-b pr-2 pl-3 text-left transition-colors"
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
  githubBrowseBaseUrl,
  effectiveThreadId,
  projectModeId,
  onAfterAction,
  unpushed,
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
  githubBrowseBaseUrl: string | null;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  onAfterAction: () => void;
  unpushed: boolean;
  /** HEAD row with a dirty tree → draw the dashed stub up to the WIP node. */
  connectToWip: boolean;
  /** Active filter query — highlights matching substrings in the title & refs. */
  searchQuery: string;
  transform: number;
  rowHeight: number;
  onSelect: () => void;
}) {
  const { t } = useTranslation();

  // Serve the node avatar from the short-TTL blob cache so scrolling the
  // virtualized list doesn't re-hit GitHub for the same image (avoids 429s).
  const cachedAvatarUrl = useCachedAvatar(avatarUrl);

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
  // `GitBranch`, a lone remote-tracking branch shows `Cloud`, a tag shows `Tag`.
  const lanePastel = graphLanePastel(graphRow?.nodeColor ?? 0);
  const refSegments = useMemo<PowerlineSegmentData[]>(
    () =>
      foldGraphRefs(entry.refs, entry.headBranch).map((r, i) => {
        const color = r.isCurrent
          ? lanePastel
          : darkenHex(lanePastel, Math.min(0.18 + i * 0.14, 0.5));
        if (r.kind === 'tag') {
          return { key: `tag:${r.name}`, icon: Tag, label: r.name, color, tooltip: r.name };
        }
        if (r.kind === 'remote') {
          return {
            key: `remote:${r.name}`,
            icon: Cloud,
            label: r.name,
            color,
            tooltip: t('graph.remoteBranch', {
              ref: r.name,
              defaultValue: `${r.name} (remote branch)`,
            }),
          };
        }
        // Local branch. Folded-in remote → CloudCheck (synced); else a plain
        // branch icon. One icon only, so the chip never shows two glyphs.
        return {
          key: `local:${r.name}`,
          icon: r.syncedRemote ? CloudCheck : GitBranch,
          label: r.name,
          color,
          emphasis: r.isCurrent,
          tooltip: r.syncedRemote
            ? t('graph.branchSynced', {
                ref: r.name,
                remote: r.syncedRemote,
                defaultValue: r.isCurrent
                  ? `${r.name} (current branch · in sync with ${r.syncedRemote})`
                  : `${r.name} (in sync with ${r.syncedRemote})`,
              })
            : r.isCurrent
              ? t('graph.currentBranch', {
                  ref: r.name,
                  defaultValue: `${r.name} (current branch)`,
                })
              : r.name,
        };
      }),
    [entry.refs, entry.headBranch, lanePastel, t],
  );

  const githubUrl = githubBrowseBaseUrl ? githubCommitUrl(githubBrowseBaseUrl, entry.hash) : null;

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
          'group flex h-full w-full cursor-pointer items-center gap-2 overflow-hidden pl-3 pr-2 text-left transition-colors',
          selected ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-accent/50',
        )}
        data-testid={`graph-commit-${entry.shortHash}`}
      >
        {/* Layout: graph | commit info, with branch/tag chips above the title. */}
        {graphRow &&
          (() => {
            // Anchor the author tooltip to the avatar node itself, not the whole
            // gutter — otherwise the tooltip centers over the (possibly wide)
            // multi-lane gutter and reads as detached from the avatar. The node
            // sits at `commitLane`'s center; its diameter mirrors GraphGutter's
            // avatar sizing so the trigger overlays the node precisely.
            const nodeCenterX = graphRow.commitLane * LANE_WIDTH + LANE_WIDTH / 2;
            const avatarDiameter =
              2 * Math.min(LANE_WIDTH / 2, Math.max(6, Math.round(rowHeight * 0.15)));
            return (
              <div style={{ width: gutterWidth }} className="relative shrink-0 self-stretch">
                <GraphGutter
                  row={graphRow}
                  laneCount={laneCount}
                  height={rowHeight}
                  avatarUrl={cachedAvatarUrl}
                  authorName={entry.author}
                  connectUp={connectToWip}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      aria-hidden
                      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                      style={{
                        left: nodeCenterX,
                        width: avatarDiameter,
                        height: avatarDiameter,
                      }}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {entry.author}
                    {unpushed && (
                      <span className="text-muted-foreground">
                        {' · '}
                        {t('history.unpushed', 'Not pushed')}
                      </span>
                    )}
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })()}
        {/* Commit info: title + time on one line, optional chips above. */}
        <div className="flex min-w-0 flex-1 flex-col justify-center pl-1">
          {/* Branch/tag chips on their own line above the commit title. */}
          {refSegments.length > 0 && (
            <div className="mb-1.5 flex min-w-0 items-center overflow-hidden">
              <PowerlineBar
                segments={refSegments}
                size="sm"
                className="min-w-0 shrink"
                query={searchQuery}
              />
            </div>
          )}
          {/* Same Tailwind classes as the History list (`CommitListPanel`) so the
              title/meta sizes are rem-based and identical across every tab. */}
          <div className="flex w-full min-w-0 items-center gap-1.5">
            <HighlightText
              text={entry.message}
              query={searchQuery}
              className="text-foreground min-w-0 flex-1 truncate text-xs leading-tight font-medium"
            />
            <span className="text-muted-foreground shrink-0 text-[10px]">
              {shortRelativeDate(entry.relativeDate)}
            </span>
          </div>
        </div>
        {/* App-standard kebab for per-commit actions, centered on the row. */}
        <CommitActionsMenu
          hash={entry.hash}
          shortHash={entry.shortHash}
          githubUrl={githubUrl}
          effectiveThreadId={effectiveThreadId}
          projectModeId={projectModeId}
          onAfterAction={onAfterAction}
        />
      </div>
    </div>
  );
}
