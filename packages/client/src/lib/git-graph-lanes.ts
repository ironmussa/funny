/**
 * Lane-assignment for the commit graph gutter.
 *
 * Given commits in any child-before-parent order (both `git log --topo-order`
 * and `--date-order` guarantee this; the graph log uses `--date-order` so
 * divergent branches interleave by date like GitKraken), assign each commit a
 * horizontal "lane" and compute the line segments to draw within each row's
 * vertical band so the branch/merge topology reads like GitKraken / VS Code's
 * Git Graph.
 *
 * This module is intentionally pure (no React, no DOM) so it can be unit
 * tested directly. The SVG renderer in `GraphGutter` just maps lanes → x
 * coordinates and `fromY`/`toY` (0 = top, 0.5 = node center, 1 = bottom) → y.
 */

export interface GraphCommit {
  hash: string;
  parentHashes: string[];
}

/** A single line to draw inside one row's band. */
export interface GraphSegment {
  fromLane: number;
  /** 0 = top edge, 0.5 = node center, 1 = bottom edge. */
  fromY: number;
  toLane: number;
  toY: number;
  /**
   * Color index of the line this segment belongs to: the color key of the
   * branch whose rail it is (see `GraphLayoutOptions.colorKeyOf`), or the lane
   * index when no keys are given.
   */
  color: number;
  /**
   * Part of the rail reserved for HEAD above its row (see `headHash`): the
   * connector from the "Uncommitted changes" node down to HEAD. Drawn dashed
   * when the tree is dirty, hidden otherwise.
   */
  wip?: true;
}

export interface GraphRow {
  /** Lane index of the commit's node dot. */
  commitLane: number;
  /** Color index for the node dot (its rail's color; = commitLane without keys). */
  nodeColor: number;
  segments: GraphSegment[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Number of lanes in use at the widest point — drives gutter width. */
  laneCount: number;
}

const Y_TOP = 0;
const Y_NODE = 0.5;
const Y_BOTTOM = 1;

export interface GraphLayoutOptions {
  /**
   * The checked-out commit. When it is in the window, lane 0 is reserved for it
   * from the top of the graph, so HEAD and its first-parent line stay on the
   * leftmost rail and the line from the "Uncommitted changes" node runs
   * straight down to it; branches newer than HEAD take the lanes to its right
   * and curve into it instead.
   */
  headHash?: string | null;
  /**
   * Stable color key for a commit, so a branch keeps its color whatever lane it
   * lands on. Called for every commit: a branch tip returns the key of its
   * branch (e.g. a hash of the branch name), which recolors the tip's node and
   * the rail below it; any other commit returns `undefined` and inherits its
   * child's rail color. A rail that opens on a commit with no key and no child
   * in view (an unnamed tip, a merged branch's side) uses `fallbackColorKeyOf`.
   * Without this option, colors are lane indices.
   */
  colorKeyOf?: (hash: string) => number | undefined;
  /** Key for a rail opened on a commit `colorKeyOf` has no key for. */
  fallbackColorKeyOf?: (hash: string) => number;
}

/**
 * The lanes while the commits are walked: `lanes[i]` is the hash of the commit
 * we next expect to reach on lane i (or null), `colors[i]` the color of the rail
 * on it.
 */
interface LaneState {
  lanes: (string | null)[];
  colors: number[];
  /**
   * Every hash that appears as a node in this window. A parent in this set will
   * be reached later as its own row, so sibling branches that share it should
   * each keep a distinct lane and only converge AT that row (GitKraken-style
   * fan-out). A parent NOT in the set is off-window and never converges, so
   * siblings must reuse a single lane for it to avoid endless parallel rails.
   */
  inWindow: ReadonlySet<string>;
  /** Color of a rail that starts at `hash` on `lane` with nothing above it. */
  openColor: (hash: string, lane: number) => number;
}

function firstFree(lanes: readonly (string | null)[]): number {
  const idx = lanes.indexOf(null);
  return idx === -1 ? lanes.length : idx;
}

/** Grow the lanes so `lane` exists (as a free slot when new). */
function ensureLane(lanes: (string | null)[], lane: number): void {
  while (lanes.length <= lane) lanes.push(null);
}

/** Put `hash` on `lane` with `color` (or the color of a rail opened there). */
function claimLane(state: LaneState, lane: number, hash: string, color: number | null): number {
  ensureLane(state.lanes, lane);
  state.lanes[lane] = hash;
  state.colors[lane] = color ?? state.openColor(hash, lane);
  return lane;
}

/**
 * Route a parent. First parent prefers the node's own lane; a parent that is
 * already tracked by some lane reuses it (a merge closing a branch).
 */
function routeParent(
  state: LaneState,
  parentHash: string,
  preferred: number | null,
  color: number | null,
): number {
  const existing = state.lanes.indexOf(parentHash);
  // Reuse an existing lane ONLY for an off-window parent. For an in-window
  // parent we deliberately open a fresh lane (preferring the node's own lane
  // for the first parent) so each branch keeps its own rail down to the
  // shared commit and they fan in there, instead of collapsing one row early.
  if (existing !== -1 && !state.inWindow.has(parentHash)) return existing;
  const lane = preferred !== null && state.lanes[preferred] == null ? preferred : null;
  return claimLane(state, lane ?? firstFree(state.lanes), parentHash, color);
}

/** The lane a commit's node sits in, and its color. */
interface CommitPlacement {
  commitLane: number;
  nodeColor: number;
}

/**
 * Find a commit's lane (a child already routed to it, else a free one) and its
 * node color, then free every lane that was waiting for it: they converge here.
 */
function placeCommit(
  state: LaneState,
  hash: string,
  colorKeyOf: GraphLayoutOptions['colorKeyOf'],
): CommitPlacement {
  const childLane = state.lanes.indexOf(hash);
  const commitLane = childLane === -1 ? firstFree(state.lanes) : childLane;
  // A branch tip takes its own color; otherwise it continues its child's rail.
  const nodeColor =
    colorKeyOf?.(hash) ??
    (childLane === -1 ? state.openColor(hash, commitLane) : state.colors[commitLane]);
  for (let i = 0; i < state.lanes.length; i++) {
    if (state.lanes[i] === hash) state.lanes[i] = null;
  }
  // Ensure the chosen node lane exists as a (now free) slot.
  ensureLane(state.lanes, commitLane);
  state.lanes[commitLane] = null;
  return { commitLane, nodeColor };
}

/**
 * The line an incoming lane draws in this row: into the node when it waited
 * for this commit, straight through when it still flows on its own lane.
 */
function incomingSegment(
  lane: number,
  hash: string,
  commit: { hash: string; lane: number },
  outgoing: readonly (string | null)[],
): Pick<GraphSegment, 'toLane' | 'toY'> | null {
  if (hash === commit.hash) return { toLane: commit.lane, toY: Y_NODE };
  // We must NOT use `outgoing.indexOf(hash)` here: when sibling branches fan
  // out, several lanes hold the same (yet-to-be-reached) parent hash, and
  // indexOf would snap every one of them onto the first such lane.
  return outgoing[lane] === hash ? { toLane: lane, toY: Y_BOTTOM } : null;
}

/** Drop repeated segments (same endpoints), keeping the first. */
function uniqueSegments(segments: GraphSegment[]): GraphSegment[] {
  const seen = new Set<string>();
  return segments.filter((s) => {
    const key = `${s.fromLane},${s.fromY},${s.toLane},${s.toY}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Compute the lane layout for a list of commits already in child-before-parent
 * order (topo- or date-order). Robust to a windowed log (parents outside the
 * window simply terminate their lane with no further node).
 */
export function computeGraphRows(
  commits: GraphCommit[],
  { headHash = null, colorKeyOf, fallbackColorKeyOf }: GraphLayoutOptions = {},
): GraphLayout {
  const openColor = (hash: string, lane: number): number =>
    colorKeyOf ? (colorKeyOf(hash) ?? fallbackColorKeyOf?.(hash) ?? lane) : lane;
  const reservedHead =
    headHash && commits.some((commit) => commit.hash === headHash) ? headHash : null;
  const state: LaneState = {
    lanes: reservedHead ? [reservedHead] : [],
    colors: reservedHead ? [openColor(reservedHead, 0)] : [],
    inWindow: new Set(commits.map((commit) => commit.hash)),
    openColor,
  };
  // Lane 0 carries the reserved HEAD rail until HEAD's own row is reached.
  let headRailOpen = reservedHead !== null;
  const rows: GraphRow[] = [];
  let laneCount = 0;

  for (const commit of commits) {
    const incoming = state.lanes.slice();
    const incomingColors = state.colors.slice();
    const { commitLane, nodeColor } = placeCommit(state, commit.hash, colorKeyOf);

    // The first parent continues this commit's rail (and color); a merge's
    // other parents open a rail colored for the branch they came from.
    const parentLanes = commit.parentHashes.map((parentHash, idx) =>
      idx === 0
        ? routeParent(state, parentHash, commitLane, nodeColor)
        : routeParent(state, parentHash, null, null),
    );

    // Pass-through and converging lines from the incoming state, then node → parent lines.
    const segments: GraphSegment[] = [];
    incoming.forEach((hash, lane) => {
      const to =
        hash && incomingSegment(lane, hash, { hash: commit.hash, lane: commitLane }, state.lanes);
      if (!to) return;
      const wip = headRailOpen && lane === 0 ? ({ wip: true } as const) : {};
      segments.push({ fromLane: lane, fromY: Y_TOP, ...to, color: incomingColors[lane], ...wip });
    });
    if (commit.hash === reservedHead) headRailOpen = false;
    for (const p of parentLanes) {
      segments.push({
        fromLane: commitLane,
        fromY: Y_NODE,
        toLane: p,
        toY: Y_BOTTOM,
        color: state.colors[p],
      });
    }
    rows.push({ commitLane, nodeColor, segments: uniqueSegments(segments) });

    // Track widest extent (consider both states + node + parents).
    laneCount = Math.max(
      laneCount,
      state.lanes.length,
      incoming.length,
      commitLane + 1,
      ...parentLanes.map((l) => l + 1),
    );

    // Trim trailing nulls so width stays tight.
    while (state.lanes.length > 0 && state.lanes[state.lanes.length - 1] === null)
      state.lanes.pop();
    state.colors.length = Math.min(state.colors.length, state.lanes.length);
  }

  return { rows, laneCount: Math.max(laneCount, 1) };
}
