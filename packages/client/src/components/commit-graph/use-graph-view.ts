import { useMemo } from 'react';

import { type GraphEntry, REBASE_LINK_RAIL_WIDTH } from '@/components/commit-graph/graph-entry';
import { LANE_WIDTH } from '@/components/commit-graph/GraphGutter';
import { useGraphLayout } from '@/components/commit-graph/use-graph-layout';
import type { GitRebaseReflogEventDTO } from '@/lib/api/git';
import { renderedGraphLaneCount } from '@/lib/commit-graph-layout';
import type { GraphRow } from '@/lib/git-graph-lanes';
import {
  collectCommitAuthors,
  commitMatchesFilters,
  type CommitSyncFilter,
} from '@/lib/git-history-search';
import {
  graphNodeForkedFromRefLabels,
  graphNodeParentLabels,
  graphNodeParentRefLabels,
  inferUnpulledHashesFromGraphEntries,
} from '@/lib/graph-refs';
import {
  indexRebaseEventsByHash,
  inferRebaseCopyLinks,
  type RebaseCopyLink,
} from '@/lib/rebase-events';
import { rebaseCopyLinkUsesOuterRail } from '@/lib/rebase-link-path';

/** Width of the outer rail rebase-copy links need, or 0 when every link fits between lanes. */
function rebaseRailWidthFor(
  displayEntries: GraphEntry[],
  rows: GraphRow[],
  rebaseCopyLinks: RebaseCopyLink[],
  laneCount: number,
): number {
  if (rebaseCopyLinks.length === 0) return 0;
  const laneByHash = new Map<string, number>();
  for (let index = 0; index < displayEntries.length; index += 1) {
    const row = rows[index];
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
}

/**
 * What the graph shows for the loaded entries and active filters: the rows that
 * pass the filters, their lane layout, the rebase-copy links and the node
 * tooltip labels.
 */
export function useGraphView({
  entries,
  searchQuery,
  syncFilter,
  authors,
  unpushed,
  unpulled,
  rebaseEvents,
}: {
  entries: GraphEntry[];
  searchQuery: string;
  syncFilter: CommitSyncFilter;
  authors: string[];
  unpushed: Set<string>;
  unpulled: Set<string>;
  rebaseEvents: GitRebaseReflogEventDTO[];
}) {
  const isFiltering = searchQuery.trim().length > 0 || syncFilter !== 'all' || authors.length > 0;
  const authorOptions = useMemo(() => collectCommitAuthors(entries), [entries]);
  const inferredUnpulled = useMemo(() => inferUnpulledHashesFromGraphEntries(entries), [entries]);
  const displayEntries = useMemo(
    () =>
      isFiltering
        ? entries.filter((entry) =>
            commitMatchesFilters(
              entry,
              searchQuery,
              syncFilter,
              unpushed,
              unpulled,
              inferredUnpulled,
              authors,
            ),
          )
        : entries,
    [entries, searchQuery, syncFilter, authors, isFiltering, unpushed, unpulled, inferredUnpulled],
  );
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

  const { layout, branchColorByLabel } = useGraphLayout(displayEntries, isFiltering);
  const laneCount = renderedGraphLaneCount(layout.laneCount);
  const laneGutterWidth = laneCount * LANE_WIDTH;
  const rebaseRailWidth = useMemo(
    () => rebaseRailWidthFor(displayEntries, layout.rows, rebaseCopyLinks, laneCount),
    [displayEntries, laneCount, layout.rows, rebaseCopyLinks],
  );

  return {
    isFiltering,
    authorOptions,
    inferredUnpulled,
    displayEntries,
    rebaseEventsByHash,
    rebaseCopyLinks,
    rebaseParentRefLabelByHash,
    forkedFromRefLabelByHash,
    parentLabelByHash,
    layout,
    branchColorByLabel,
    laneCount,
    gutterWidth: laneGutterWidth + rebaseRailWidth,
  };
}

export type GraphView = ReturnType<typeof useGraphView>;
