import { useMemo, useState, type KeyboardEvent, type WheelEvent } from 'react';

import { CommitActionsMenu } from '@/components/commit-graph/CommitActionsMenu';
import {
  type GraphEntry,
  hasDistinctCommitterIdentity,
  META_PX,
  nodeYForRow,
  TITLE_PX,
  titleYForRow,
} from '@/components/commit-graph/graph-entry';
import {
  GraphCommitSyncMarkers,
  GraphCommitTime,
} from '@/components/commit-graph/GraphCommitMarkers';
import { GRAPH_NODE_RADIUS, GraphGutter, LANE_WIDTH } from '@/components/commit-graph/GraphGutter';
import { GraphNodeTooltipContent } from '@/components/commit-graph/GraphNodeTooltip';
import { GraphRefChips, isThreadBranchRef } from '@/components/commit-graph/GraphRefChips';
import { PRBadge } from '@/components/PRBadge';
import { HighlightText } from '@/components/ui/highlight-text';
import { HoverTimeMenu } from '@/components/ui/hover-time-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { GitRebaseReflogEventDTO } from '@/lib/api/git';
import { useCachedAvatar } from '@/lib/avatar-cache';
import { graphRefLeaderLineXRange } from '@/lib/commit-graph-layout';
import type { GraphRow } from '@/lib/git-graph-lanes';
import { githubCommitUrlForRemoteCommit } from '@/lib/github-url';
import { graphLanePastel } from '@/lib/graph-colors';
import {
  foldGraphRefs,
  type GraphBranchSummary,
  type GraphNodeParentLabel,
  pinThreadBranchFirst,
  threadBaseBranchesAt,
} from '@/lib/graph-refs';
import { cn } from '@/lib/utils';

export interface GraphCommitRowProps {
  entry: GraphEntry;
  graphRow: GraphRow | undefined;
  laneCount: number;
  gutterWidth: number;
  graphViewportWidth: number;
  graphScrollLeft: number;
  onGraphGutterWheel: (event: WheelEvent<HTMLDivElement>) => void;
  selected: boolean;
  avatarUrl: string | undefined;
  committerAvatarUrl: string | undefined;
  githubBrowseBaseUrl: string | null;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  onAfterAction: () => void;
  /** Opens the new-thread composer on a branch; null when there is no project. */
  onCreateThreadFromBranch: ((branch: string) => void) | null;
  branchSummaryByName: ReadonlyMap<string, GraphBranchSummary>;
  branchActionInProgress: string | null;
  onPushBranch: (branch: string) => void;
  onPullCurrentBranch: (branch: string) => void;
  rebaseEvents: GitRebaseReflogEventDTO[];
  onSelectRebaseEvent: (event: GitRebaseReflogEventDTO) => void;
  forkedFromRefLabel: string | null;
  parentLabel: GraphNodeParentLabel | null;
  /** Branch label → its tip's lane pastel (tooltip branch dots). */
  branchColorByLabel: ReadonlyMap<string, string>;
  unpushed: boolean;
  unpulled: boolean;
  /** HEAD row with a dirty tree → draw the dashed stub up to the WIP node. */
  connectToWip: boolean;
  /** Active filter query — highlights matching substrings in the title & refs. */
  searchQuery: string;
  /** Branch the open thread works on; its chip gets an arrow marker. */
  threadBranch: string | null;
  transform: number;
  rowHeight: number;
  onSelect: () => void;
}

/** The props that differ per row; the list builds them for each visible commit. */
type GraphCommitRowOwnKeys =
  | 'entry'
  | 'graphRow'
  | 'selected'
  | 'avatarUrl'
  | 'committerAvatarUrl'
  | 'rebaseEvents'
  | 'forkedFromRefLabel'
  | 'parentLabel'
  | 'unpushed'
  | 'unpulled'
  | 'connectToWip'
  | 'transform'
  | 'rowHeight'
  | 'onSelect';

export type GraphCommitRowOwnProps = Pick<GraphCommitRowProps, GraphCommitRowOwnKeys>;

/** The row props every commit row shares. */
export type GraphCommitRowSharedProps = Omit<GraphCommitRowProps, GraphCommitRowOwnKeys>;

/**
 * The node avatar and, when the committer differs from the author, the
 * committer's, both served from the short-TTL blob cache so scrolling the
 * virtualized list doesn't re-hit GitHub for the same image (avoids 429s).
 */
function useRowAvatars(
  entry: GraphEntry,
  avatarUrl: string | undefined,
  committerAvatarUrl: string | undefined,
) {
  const cachedAvatarUrl = useCachedAvatar(avatarUrl);
  const hasDistinctCommitter = hasDistinctCommitterIdentity(entry);
  const cachedCommitterAvatarUrl = useCachedAvatar(
    hasDistinctCommitter ? committerAvatarUrl : undefined,
  );
  return { cachedAvatarUrl, hasDistinctCommitter, cachedCommitterAvatarUrl };
}

/**
 * The refs on one commit row, folded and ordered for its chips, plus what its
 * actions menu offers: PR links, pushable branches, merge targets, thread bases.
 */
function useCommitRowRefs(
  entry: GraphEntry,
  threadBranch: string | null,
  branchSummaryByName: ReadonlyMap<string, GraphBranchSummary>,
) {
  const foldedRefs = useMemo(
    // The open thread's branch goes first so its arrow runs straight along the
    // leader line; the order changes with the selected thread.
    () => pinThreadBranchFirst(foldGraphRefs(entry.refs, entry.headBranch), threadBranch),
    [entry.refs, entry.headBranch, threadBranch],
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
      foldedRefs.flatMap((ref) =>
        ref.kind === 'local' && !ref.syncedRemote && ref.name !== 'HEAD' ? [ref.name] : [],
      ),
    [foldedRefs],
  );
  const targetBranches = useMemo(
    () =>
      foldedRefs.flatMap((ref) =>
        ref.kind === 'local' && ref.name !== 'HEAD' && !branchSummaryByName.get(ref.name)?.isCurrent
          ? [ref.name]
          : [],
      ),
    [branchSummaryByName, foldedRefs],
  );
  const threadBranches = useMemo(() => threadBaseBranchesAt(foldedRefs), [foldedRefs]);
  return { foldedRefs, pullRequestLinks, pushableBranches, targetBranches, threadBranches };
}

/**
 * Straight horizontal line from a commit node to its branch/tag chip, so it's
 * unambiguous which node the powerline belongs to. Null when the node is
 * scrolled out of the gutter viewport.
 */
function RefLeaderLine({
  commitLane,
  graphScrollLeft,
  graphViewportWidth,
  y,
  color,
  emphasized,
}: {
  commitLane: number;
  graphScrollLeft: number;
  graphViewportWidth: number;
  y: number;
  color: string;
  /** The open thread's branch is on this leader line: draw it thicker. */
  emphasized: boolean;
}) {
  // px geometry from the row's padding-box origin (absolute inset-0).
  // Horizontal: pl-3 (12) + gutter + gap-2 (8) + info pl-1 (4).
  const avatarR = GRAPH_NODE_RADIUS;
  const nodeX = 12 + commitLane * LANE_WIDTH + LANE_WIDTH / 2 - graphScrollLeft;
  const chipLeftX = 12 + graphViewportWidth + 8 + 4;
  const leaderLine = graphRefLeaderLineXRange({
    nodeX,
    avatarR,
    graphViewportWidth,
    chipLeftX,
  });
  if (!leaderLine) return null;
  return (
    <svg
      className="pointer-events-none absolute inset-0"
      style={{ overflow: 'visible' }}
      aria-hidden="true"
    >
      <line
        x1={leaderLine.x1}
        y1={y}
        x2={leaderLine.x2}
        y2={y}
        stroke={color}
        strokeWidth={emphasized ? 3 : 1.6}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** One commit row: graph gutter + subject/refs + author avatar, hash, link. */
export function GraphCommitRow({
  row,
  shared,
}: {
  row: GraphCommitRowOwnProps;
  shared: GraphCommitRowSharedProps;
}) {
  const {
    entry,
    graphRow,
    laneCount,
    gutterWidth,
    graphViewportWidth,
    graphScrollLeft,
    onGraphGutterWheel,
    selected,
    avatarUrl,
    committerAvatarUrl,
    githubBrowseBaseUrl,
    effectiveThreadId,
    projectModeId,
    onAfterAction,
    onCreateThreadFromBranch,
    branchSummaryByName,
    branchActionInProgress,
    onPushBranch,
    onPullCurrentBranch,
    rebaseEvents,
    onSelectRebaseEvent,
    forkedFromRefLabel,
    parentLabel,
    branchColorByLabel,
    unpushed,
    unpulled,
    connectToWip,
    searchQuery,
    threadBranch,
    transform,
    rowHeight,
    onSelect,
  }: GraphCommitRowProps = { ...shared, ...row };
  // Keep the kebab pinned (and the time hidden) while its dropdown is open.
  const [menuOpen, setMenuOpen] = useState(false);

  const { cachedAvatarUrl, hasDistinctCommitter, cachedCommitterAvatarUrl } = useRowAvatars(
    entry,
    avatarUrl,
    committerAvatarUrl,
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
  const { foldedRefs, pullRequestLinks, pushableBranches, targetBranches, threadBranches } =
    useCommitRowRefs(entry, threadBranch, branchSummaryByName);

  const githubUrl = githubCommitUrlForRemoteCommit(githubBrowseBaseUrl, entry.hash, unpushed);
  const commitTime = useMemo(
    () => <GraphCommitTime committedAt={entry.committedAt} />,
    [entry.committedAt],
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
  const threadBranchOnLeader = !!foldedRefs[0] && isThreadBranchRef(foldedRefs[0], threadBranch);
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
        onKeyDown={(e) => activateOnEnterOrSpace(e, onSelect)}
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
        {hasRefs && graphRow && (
          <RefLeaderLine
            commitLane={graphRow.commitLane}
            graphScrollLeft={graphScrollLeft}
            graphViewportWidth={graphViewportWidth}
            y={chipCenterY}
            color={lanePastel}
            emphasized={threadBranchOnLeader}
          />
        )}
        {/* Layout: graph | commit info, with branch/tag chips above the title. */}
        {graphRow && (
          <GraphCommitNode
            entry={entry}
            graphRow={graphRow}
            laneCount={laneCount}
            gutterWidth={gutterWidth}
            graphViewportWidth={graphViewportWidth}
            graphScrollLeft={graphScrollLeft}
            onGraphGutterWheel={onGraphGutterWheel}
            rowHeight={rowHeight}
            nodeYFrac={nodeYFrac}
            avatarUrl={cachedAvatarUrl}
            committerAvatarUrl={cachedCommitterAvatarUrl}
            hasDistinctCommitter={hasDistinctCommitter}
            connectToWip={connectToWip}
            forkedFromRefLabel={forkedFromRefLabel}
            parentLabel={parentLabel}
            branchColorByLabel={branchColorByLabel}
            unpushed={unpushed}
          />
        )}
        {/* Commit info: title line, optional branch/tag chips above it. */}
        <div className="flex min-w-0 flex-1 flex-col justify-center pl-1">
          {/* Branch/tag chips on their own line above the commit title. */}
          {foldedRefs.length > 0 && (
            <GraphCommitRefsLine
              foldedRefs={foldedRefs}
              pullRequestLinks={pullRequestLinks}
              lineHeight={chipLineH}
              branchSummaryByName={branchSummaryByName}
              githubBrowseBaseUrl={githubBrowseBaseUrl}
              branchActionInProgress={branchActionInProgress}
              color={lanePastel}
              searchQuery={searchQuery}
              threadBranch={threadBranch}
              onPushBranch={onPushBranch}
              onPullCurrentBranch={onPullCurrentBranch}
            />
          )}
          {/* Rem-based title/meta sizes, identical across every tab. */}
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
        {/* Aligned with the title line, not the row's middle: in a row with
            branch/tag chips the middle is the chip line. */}
        <div
          className="flex min-w-12 shrink-0 items-center self-start"
          style={{
            height: titleLineH,
            marginTop: titleYForRow(entry, rowHeight) - titleLineH / 2,
          }}
        >
          <HoverTimeMenu
            time={commitTime}
            timeClassName="text-muted-foreground text-2xs"
            open={menuOpen}
            className="min-w-12"
          >
            <CommitActionsMenu
              hash={entry.hash}
              shortHash={entry.shortHash}
              githubUrl={githubUrl}
              effectiveThreadId={effectiveThreadId}
              projectModeId={projectModeId}
              localBranches={pushableBranches}
              targetBranches={targetBranches}
              threadBranches={threadBranches}
              onCreateThreadFromBranch={onCreateThreadFromBranch ?? undefined}
              rebaseEvents={rebaseEvents}
              onSelectRebaseEvent={onSelectRebaseEvent}
              onAfterAction={onAfterAction}
              onOpenChange={setMenuOpen}
              triggerClassName="text-muted-foreground hover:text-foreground"
            />
          </HoverTimeMenu>
        </div>
      </div>
    </div>
  );
}

interface GraphCommitNodeProps extends Pick<
  GraphCommitRowProps,
  | 'entry'
  | 'laneCount'
  | 'gutterWidth'
  | 'graphViewportWidth'
  | 'graphScrollLeft'
  | 'onGraphGutterWheel'
  | 'rowHeight'
  | 'avatarUrl'
  | 'committerAvatarUrl'
  | 'connectToWip'
  | 'forkedFromRefLabel'
  | 'parentLabel'
  | 'branchColorByLabel'
  | 'unpushed'
> {
  graphRow: GraphRow;
  nodeYFrac: number;
  hasDistinctCommitter: boolean;
}

/** The row's graph gutter, with the identity tooltip anchored on its avatar node. */
function GraphCommitNode({
  entry,
  graphRow,
  laneCount,
  gutterWidth,
  graphViewportWidth,
  graphScrollLeft,
  onGraphGutterWheel,
  rowHeight,
  nodeYFrac,
  avatarUrl,
  committerAvatarUrl,
  hasDistinctCommitter,
  connectToWip,
  forkedFromRefLabel,
  parentLabel,
  branchColorByLabel,
  unpushed,
}: GraphCommitNodeProps) {
  // Anchor the identity tooltip to the avatar node itself, not the whole
  // gutter — otherwise the tooltip centers over the (possibly wide)
  // multi-lane gutter and reads as detached from the avatar. The node
  // sits at `commitLane`'s center with GraphGutter's fixed node radius,
  // so the trigger overlays it precisely.
  const nodeCenterX = graphRow.commitLane * LANE_WIDTH + LANE_WIDTH / 2;
  const nodeHitboxSize = 2 * GRAPH_NODE_RADIUS;
  return (
    <div
      style={{ width: graphViewportWidth }}
      className="shrink-0 self-stretch overflow-hidden"
      onWheel={onGraphGutterWheel}
    >
      <div
        style={{ width: gutterWidth, transform: `translateX(-${graphScrollLeft}px)` }}
        className="relative h-full"
      >
        <GraphGutter
          row={graphRow}
          laneCount={laneCount}
          height={rowHeight}
          avatarUrl={avatarUrl}
          authorName={entry.author}
          distinctCommitter={hasDistinctCommitter}
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
            <GraphNodeTooltipContent
              entry={entry}
              avatarUrl={avatarUrl}
              committerAvatarUrl={committerAvatarUrl}
              hasDistinctCommitter={hasDistinctCommitter}
              forkedFromRefLabel={forkedFromRefLabel}
              parentLabel={parentLabel}
              branchColorByLabel={branchColorByLabel}
              unpushed={unpushed}
            />
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

type CommitRowRefs = ReturnType<typeof useCommitRowRefs>;

interface GraphCommitRefsLineProps extends Pick<
  GraphCommitRowProps,
  | 'branchSummaryByName'
  | 'githubBrowseBaseUrl'
  | 'branchActionInProgress'
  | 'searchQuery'
  | 'threadBranch'
  | 'onPushBranch'
  | 'onPullCurrentBranch'
> {
  foldedRefs: CommitRowRefs['foldedRefs'];
  pullRequestLinks: CommitRowRefs['pullRequestLinks'];
  /** Height of one chip line. */
  lineHeight: number;
  color: string;
}

/** The branch/tag chips and PR badges on their own line above the commit title. */
function GraphCommitRefsLine({
  foldedRefs,
  pullRequestLinks,
  lineHeight,
  branchSummaryByName,
  githubBrowseBaseUrl,
  branchActionInProgress,
  color,
  searchQuery,
  threadBranch,
  onPushBranch,
  onPullCurrentBranch,
}: GraphCommitRefsLineProps) {
  return (
    <div
      className="mb-1.5 flex min-w-0 shrink-0 items-center overflow-hidden"
      style={{ height: foldedRefs.length * lineHeight + (foldedRefs.length - 1) * 4 }}
    >
      {/* Branches on a commit are siblings, not a hierarchy — render
          them as separate pills (`chips`) rather than connected powerline
          chevrons, which read as one continuous path when two branch tips
          share a commit. A folded local+remote pair is already ONE chip,
          so distinct chips here always mean distinct branches/tags. */}
      <GraphRefChips
        refs={foldedRefs}
        branchSummaryByName={branchSummaryByName}
        githubBrowseBaseUrl={githubBrowseBaseUrl}
        actionInProgress={branchActionInProgress}
        color={color}
        searchQuery={searchQuery}
        threadBranch={threadBranch}
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
  );
}

/** Treat Enter / Space on a `role="button"` element as a click. */
function activateOnEnterOrSpace(e: KeyboardEvent<HTMLElement>, onActivate: () => void) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    onActivate();
  }
}
