import { useMemo } from 'react';

import { computeGraphRows } from '@/lib/git-graph-lanes';
import { graphColorKey, graphLanePastel } from '@/lib/graph-colors';
import {
  graphBranchColorNameByHash,
  graphBranchTipHashByLabel,
  graphHeadHash,
} from '@/lib/graph-refs';

/** Lane layout of the visible rows (computed once per entries / filter change). */
function graphLayout(entries: GraphLayoutEntries, isFiltering: boolean) {
  // While filtering, the surviving commits are no longer contiguous in topo
  // order, so the lane graph would render as a meaningless staircase. Show a
  // flat list instead: one standalone node per row, no connecting rails.
  if (isFiltering) {
    return {
      rows: entries.map(() => ({
        commitLane: 0,
        nodeColor: 0,
        segments: [],
      })),
      laneCount: 1,
    };
  }
  const colorNames = graphBranchColorNameByHash(entries);
  return computeGraphRows(
    entries.map((e) => ({
      hash: e.hash,
      parentHashes: e.parentHashes,
    })),
    {
      // The checked-out commit takes the leftmost lane, under the WIP node.
      headHash: graphHeadHash(entries),
      // Each branch keeps one color, keyed on its name, whatever lane it lands on.
      colorKeyOf: (hash) => {
        const name = colorNames.get(hash);
        return name === undefined ? undefined : graphColorKey(name);
      },
      fallbackColorKeyOf: graphColorKey,
    },
  );
}

type GraphLayoutEntries = readonly (Parameters<typeof graphBranchTipHashByLabel>[0][number] & {
  parentHashes: string[];
})[];

/**
 * Branch label → its tip's lane pastel, for the colored dots in the node
 * tooltip's parent-branch list (same color as the branch's chip and line).
 */
function branchColorsByLabel(
  entries: GraphLayoutEntries,
  layout: ReturnType<typeof graphLayout>,
): ReadonlyMap<string, string> {
  const rowIndexByHash = new Map(entries.map((e, index) => [e.hash, index]));
  const colors = new Map<string, string>();
  for (const [label, hash] of graphBranchTipHashByLabel(entries)) {
    const row = layout.rows[rowIndexByHash.get(hash) ?? -1];
    if (row) colors.set(label, graphLanePastel(row.nodeColor));
  }
  return colors;
}

/** The graph's lane layout plus each branch's lane color, recomputed together. */
export function useGraphLayout(entries: GraphLayoutEntries, isFiltering: boolean) {
  return useMemo(() => {
    const layout = graphLayout(entries, isFiltering);
    return { layout, branchColorByLabel: branchColorsByLabel(entries, layout) };
  }, [entries, isFiltering]);
}
