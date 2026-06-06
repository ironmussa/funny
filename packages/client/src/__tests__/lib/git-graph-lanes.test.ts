import { describe, expect, test } from 'vitest';

import { computeGraphRows, type GraphCommit } from '@/lib/git-graph-lanes';

/** Convenience: build a commit in topo order. */
const c = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parentHashes: parents });

describe('computeGraphRows', () => {
  test('empty input yields no rows but a minimum lane count of 1', () => {
    const layout = computeGraphRows([]);
    expect(layout.rows).toHaveLength(0);
    expect(layout.laneCount).toBe(1);
  });

  test('linear history stays in a single lane', () => {
    // A -> B -> C  (A is the tip/child, C the root)
    const layout = computeGraphRows([c('A', 'B'), c('B', 'C'), c('C')]);
    expect(layout.laneCount).toBe(1);
    expect(layout.rows.map((r) => r.commitLane)).toEqual([0, 0, 0]);

    // Tip A has no incoming child, just an edge down to its parent.
    expect(layout.rows[0].segments).toEqual([
      { fromLane: 0, fromY: 0.5, toLane: 0, toY: 1, color: 0 },
    ]);
    // Root C converges from its child but emits no parent edge.
    expect(layout.rows[2].segments).toEqual([
      { fromLane: 0, fromY: 0, toLane: 0, toY: 0.5, color: 0 },
    ]);
  });

  test('merge commit opens a second lane and routes both parents', () => {
    // M (merge of P1, P2) -> both reach base B
    const layout = computeGraphRows([c('M', 'P1', 'P2'), c('P1', 'B'), c('P2', 'B'), c('B')]);

    expect(layout.laneCount).toBe(2);
    // The merge node sits in lane 0 and emits two downward edges.
    const mergeRow = layout.rows[0];
    expect(mergeRow.commitLane).toBe(0);
    const parentEdges = mergeRow.segments.filter((s) => s.fromY === 0.5 && s.toY === 1);
    expect(parentEdges).toHaveLength(2);
    expect(parentEdges.map((s) => s.toLane).sort()).toEqual([0, 1]);

    // P2 lives in lane 1, then merges back into base on lane 0.
    expect(layout.rows[2].commitLane).toBe(1);
    // Base collapses back to a single lane.
    expect(layout.rows[3].commitLane).toBe(0);
  });

  test('two tips off a shared base occupy distinct lanes', () => {
    // X and Y both branch from base B, with no child link between them.
    const layout = computeGraphRows([c('X', 'B'), c('Y', 'B'), c('B')]);
    expect(layout.laneCount).toBe(2);
    expect(layout.rows.map((r) => r.commitLane)).toEqual([0, 1, 0]);
    // Y emits an edge that lands on lane 0 (the shared base).
    const yParentEdge = layout.rows[1].segments.find((s) => s.fromY === 0.5 && s.toY === 1);
    expect(yParentEdge?.toLane).toBe(0);
  });

  test('root commit (no parents) emits no parent edge', () => {
    const layout = computeGraphRows([c('only')]);
    expect(layout.rows[0].commitLane).toBe(0);
    expect(layout.rows[0].segments).toHaveLength(0);
  });

  test('windowed log: a parent outside the window terminates its lane cleanly', () => {
    // The graph-log endpoint is paginated, so the last row's parent often falls
    // outside the fetched window. The module documents this as a supported case
    // ("parents outside the window simply terminate their lane"). The commit
    // must still render a downward edge toward its (off-window) parent without
    // opening extra lanes or producing a dangling node row.
    const layout = computeGraphRows([c('A', 'B')]); // B is never emitted as a node
    expect(layout.rows).toHaveLength(1);
    expect(layout.laneCount).toBe(1);
    expect(layout.rows[0].commitLane).toBe(0);
    expect(layout.rows[0].segments).toEqual([
      { fromLane: 0, fromY: 0.5, toLane: 0, toY: 1, color: 0 },
    ]);
  });

  test('windowed log: two tips sharing an off-window parent reuse its lane', () => {
    // Both A and B point at Z, which is outside the window. They must converge
    // on a single lane for Z rather than each opening its own.
    const layout = computeGraphRows([c('A', 'Z'), c('B', 'Z')]);
    const aParent = layout.rows[0].segments.find((s) => s.fromY === 0.5 && s.toY === 1);
    const bParent = layout.rows[1].segments.find((s) => s.fromY === 0.5 && s.toY === 1);
    expect(aParent?.toLane).toBe(0);
    expect(bParent?.toLane).toBe(0); // reuses Z's existing lane, not a new one
  });

  test('octopus merge routes all three parents to distinct lanes', () => {
    // A 3-parent merge exercises the parent loop beyond the binary-merge case.
    const layout = computeGraphRows([
      c('M', 'P1', 'P2', 'P3'),
      c('P1', 'B'),
      c('P2', 'B'),
      c('P3', 'B'),
      c('B'),
    ]);
    expect(layout.laneCount).toBe(3);
    const parentEdges = layout.rows[0].segments.filter((s) => s.fromY === 0.5 && s.toY === 1);
    expect(parentEdges).toHaveLength(3);
    expect(parentEdges.map((s) => s.toLane).sort()).toEqual([0, 1, 2]);
    // Everything collapses back to the shared base on lane 0.
    expect(layout.rows[4].commitLane).toBe(0);
  });
});
