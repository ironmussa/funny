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
 * Compute the lane layout for a list of commits already in child-before-parent
 * order (topo- or date-order). Robust to a windowed log (parents outside the
 * window simply terminate their lane with no further node).
 */
export function computeGraphRows(
  commits: GraphCommit[],
  { headHash = null, colorKeyOf, fallbackColorKeyOf }: GraphLayoutOptions = {},
): GraphLayout {
  // Color of a rail that starts at `hash` on `lane` with nothing above it.
  const openColor = (hash: string, lane: number): number =>
    colorKeyOf ? (colorKeyOf(hash) ?? fallbackColorKeyOf?.(hash) ?? lane) : lane;
  // lanes[i] = hash of the commit we next expect to reach on lane i, or null.
  const reservedHead =
    headHash && commits.some((commit) => commit.hash === headHash) ? headHash : null;
  const lanes: (string | null)[] = reservedHead ? [reservedHead] : [];
  // laneColors[i] = color of the rail currently on lane i (parallel to `lanes`).
  const laneColors: number[] = reservedHead ? [openColor(reservedHead, 0)] : [];
  // Lane 0 carries the reserved HEAD rail until HEAD's own row is reached.
  let headRailOpen = reservedHead !== null;
  const rows: GraphRow[] = [];
  let laneCount = 0;

  // Every hash that appears as a node in this window. A parent in this set will
  // be reached later as its own row, so sibling branches that share it should
  // each keep a distinct lane and only converge AT that row (GitKraken-style
  // fan-out). A parent NOT in the set is off-window and never converges, so
  // siblings must reuse a single lane for it to avoid endless parallel rails.
  const inWindow = new Set(commits.map((commit) => commit.hash));

  const firstFree = (): number => {
    const idx = lanes.indexOf(null);
    return idx === -1 ? lanes.length : idx;
  };

  for (const commit of commits) {
    const incoming = lanes.slice();
    const incomingColors = laneColors.slice();

    // 1. Find this commit's lane (a child already routed to it), else open one.
    let commitLane = lanes.indexOf(commit.hash);
    const hadChild = commitLane !== -1;
    if (!hadChild) commitLane = firstFree();
    // A branch tip takes its own color; otherwise it continues its child's rail.
    const ownKey = colorKeyOf?.(commit.hash);
    const nodeColor = hadChild
      ? (ownKey ?? laneColors[commitLane])
      : (ownKey ?? openColor(commit.hash, commitLane));

    // 2. Free every lane that was waiting for this commit — they converge here.
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) lanes[i] = null;
    }
    // Ensure the chosen node lane exists as a (now free) slot.
    while (lanes.length <= commitLane) lanes.push(null);
    lanes[commitLane] = null;

    // 3. Route parents. First parent prefers the node's own lane; a parent that
    //    is already tracked by some lane reuses it (a merge closing a branch).
    const assignParent = (
      parentHash: string,
      preferred: number | null,
      color: number | null,
    ): number => {
      const existing = lanes.indexOf(parentHash);
      // Reuse an existing lane ONLY for an off-window parent. For an in-window
      // parent we deliberately open a fresh lane (preferring the node's own lane
      // for the first parent) so each branch keeps its own rail down to the
      // shared commit and they fan in there, instead of collapsing one row early.
      if (existing !== -1 && !inWindow.has(parentHash)) return existing;
      if (preferred !== null && (lanes[preferred] === null || lanes[preferred] === undefined)) {
        while (lanes.length <= preferred) lanes.push(null);
        lanes[preferred] = parentHash;
        laneColors[preferred] = color ?? openColor(parentHash, preferred);
        return preferred;
      }
      const slot = firstFree();
      while (lanes.length <= slot) lanes.push(null);
      lanes[slot] = parentHash;
      laneColors[slot] = color ?? openColor(parentHash, slot);
      return slot;
    };

    const parentLanes: number[] = [];
    commit.parentHashes.forEach((parentHash, idx) => {
      // The first parent continues this commit's rail (and color); a merge's
      // other parents open a rail colored for the branch they came from.
      const lane = assignParent(
        parentHash,
        idx === 0 ? commitLane : null,
        idx === 0 ? nodeColor : null,
      );
      parentLanes.push(lane);
    });

    // 4. Build the segments for this row's band.
    const segments: GraphSegment[] = [];
    const seen = new Set<string>();
    const push = (s: GraphSegment) => {
      const key = `${s.fromLane},${s.fromY},${s.toLane},${s.toY}`;
      if (seen.has(key)) return;
      seen.add(key);
      segments.push(s);
    };

    // Pass-through and converging lines from the incoming state.
    for (let i = 0; i < incoming.length; i++) {
      const h = incoming[i];
      if (h === null) continue;
      const wip = headRailOpen && i === 0 ? ({ wip: true } as const) : {};
      if (h === commit.hash) {
        // Converges into the node.
        push({
          fromLane: i,
          fromY: Y_TOP,
          toLane: commitLane,
          toY: Y_NODE,
          color: incomingColors[i],
          ...wip,
        });
      } else if (lanes[i] === h) {
        // Still flowing on its own lane — keep it straight. We must NOT use
        // `lanes.indexOf(h)` here: when sibling branches fan out, several lanes
        // hold the same (yet-to-be-reached) parent hash, and indexOf would snap
        // every one of them onto the first such lane, collapsing the fan.
        push({
          fromLane: i,
          fromY: Y_TOP,
          toLane: i,
          toY: Y_BOTTOM,
          color: incomingColors[i],
          ...wip,
        });
      }
    }
    if (commit.hash === reservedHead) headRailOpen = false;

    // Node → parent lines.
    for (const p of parentLanes) {
      push({
        fromLane: commitLane,
        fromY: Y_NODE,
        toLane: p,
        toY: Y_BOTTOM,
        color: laneColors[p],
      });
    }

    rows.push({ commitLane, nodeColor, segments });

    // Track widest extent (consider both states + node + parents).
    const usedNow = Math.max(
      lanes.length,
      incoming.length,
      commitLane + 1,
      ...parentLanes.map((l) => l + 1),
    );
    if (usedNow > laneCount) laneCount = usedNow;

    // Trim trailing nulls so width stays tight.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    laneColors.length = Math.min(laneColors.length, lanes.length);
  }

  return { rows, laneCount: Math.max(laneCount, 1) };
}
