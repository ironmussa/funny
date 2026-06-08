/**
 * Lane-assignment for the commit graph gutter.
 *
 * Given commits in topological order (children before parents — the order
 * `git log --topo-order` produces), assign each commit a horizontal "lane" and
 * compute the line segments to draw within each row's vertical band so the
 * branch/merge topology reads like GitKraken / VS Code's Git Graph.
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
  /** Stable color index = the lane this segment belongs to. */
  color: number;
}

export interface GraphRow {
  /** Lane index of the commit's node dot. */
  commitLane: number;
  /** Color index for the node dot (= commitLane). */
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

/**
 * Compute the lane layout for a list of commits already in topological order.
 * Robust to a windowed log (parents outside the window simply terminate their
 * lane with no further node).
 */
export function computeGraphRows(commits: GraphCommit[]): GraphLayout {
  // lanes[i] = hash of the commit we next expect to reach on lane i, or null.
  const lanes: (string | null)[] = [];
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

    // 1. Find this commit's lane (a child already routed to it), else open one.
    let commitLane = lanes.indexOf(commit.hash);
    const hadChild = commitLane !== -1;
    if (!hadChild) commitLane = firstFree();

    // 2. Free every lane that was waiting for this commit — they converge here.
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) lanes[i] = null;
    }
    // Ensure the chosen node lane exists as a (now free) slot.
    while (lanes.length <= commitLane) lanes.push(null);
    lanes[commitLane] = null;

    // 3. Route parents. First parent prefers the node's own lane; a parent that
    //    is already tracked by some lane reuses it (a merge closing a branch).
    const assignParent = (parentHash: string, preferred: number | null): number => {
      const existing = lanes.indexOf(parentHash);
      // Reuse an existing lane ONLY for an off-window parent. For an in-window
      // parent we deliberately open a fresh lane (preferring the node's own lane
      // for the first parent) so each branch keeps its own rail down to the
      // shared commit and they fan in there, instead of collapsing one row early.
      if (existing !== -1 && !inWindow.has(parentHash)) return existing;
      if (preferred !== null && (lanes[preferred] === null || lanes[preferred] === undefined)) {
        while (lanes.length <= preferred) lanes.push(null);
        lanes[preferred] = parentHash;
        return preferred;
      }
      const slot = firstFree();
      while (lanes.length <= slot) lanes.push(null);
      lanes[slot] = parentHash;
      return slot;
    };

    const parentLanes: number[] = [];
    commit.parentHashes.forEach((parentHash, idx) => {
      const lane = assignParent(parentHash, idx === 0 ? commitLane : null);
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
      if (h === commit.hash) {
        // Converges into the node.
        push({ fromLane: i, fromY: Y_TOP, toLane: commitLane, toY: Y_NODE, color: i });
      } else if (lanes[i] === h) {
        // Still flowing on its own lane — keep it straight. We must NOT use
        // `lanes.indexOf(h)` here: when sibling branches fan out, several lanes
        // hold the same (yet-to-be-reached) parent hash, and indexOf would snap
        // every one of them onto the first such lane, collapsing the fan.
        push({ fromLane: i, fromY: Y_TOP, toLane: i, toY: Y_BOTTOM, color: i });
      }
    }

    // Node → parent lines.
    for (const p of parentLanes) {
      push({ fromLane: commitLane, fromY: Y_NODE, toLane: p, toY: Y_BOTTOM, color: p });
    }

    rows.push({ commitLane, nodeColor: commitLane, segments });

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
  }

  return { rows, laneCount: Math.max(laneCount, 1) };
}
