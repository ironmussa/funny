import { useId } from 'react';

import {
  type GraphEntry,
  nodeYForRow,
  REBASE_LINK_RAIL_WIDTH,
  rebaseLinkNodeEdgeX,
} from '@/components/commit-graph/graph-entry';
import { LANE_WIDTH } from '@/components/commit-graph/GraphGutter';
import type { GraphRow } from '@/lib/git-graph-lanes';
import type { RebaseCopyLink } from '@/lib/rebase-events';
import {
  rebaseCopyLinkRailLane,
  rebaseCopyLinkRailX,
  roundedRebaseCopyLinkPath,
} from '@/lib/rebase-link-path';

export interface RowRange {
  start: number;
  end: number;
}

interface RebaseLinkRow {
  index: number;
  top: number;
  nodeY: number;
  lane: number;
}

/** First and last row index the virtualizer rendered, or null before it has rendered any. */
export function renderedRangeOf(virtualItems: ReadonlyArray<{ index: number }>): RowRange | null {
  if (virtualItems.length === 0) return null;
  return { start: virtualItems[0].index, end: virtualItems[virtualItems.length - 1].index };
}

/** Each laid-out row's position, by commit hash, and the height of the whole list. */
interface RebaseLinkLayout {
  rowsByHash: Map<string, RebaseLinkRow>;
  totalHeight: number;
}

/** Each laid-out row's position, by commit hash, and the height of the whole list. */
function layoutRebaseLinkRows(
  entries: GraphEntry[],
  layoutRows: GraphRow[],
  rowHeightFor: (entry: GraphEntry) => number,
): RebaseLinkLayout {
  let totalHeight = 0;
  const rowsByHash = new Map<string, RebaseLinkRow>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const row = layoutRows[index];
    const height = rowHeightFor(entry);
    if (row) {
      rowsByHash.set(entry.hash, {
        index,
        top: totalHeight,
        nodeY: nodeYForRow(entry, height),
        lane: row.commitLane,
      });
    }
    totalHeight += height;
  }
  return { rowsByHash, totalHeight };
}

/**
 * The links whose rows are both laid out and that cross a rendered row: one
 * between two off-screen rows would be drawn with nothing around it.
 */
function rebaseLinksInRange(
  links: RebaseCopyLink[],
  rowsByHash: Map<string, RebaseLinkRow>,
  range: RowRange,
): Array<{ link: RebaseCopyLink; source: RebaseLinkRow; target: RebaseLinkRow }> {
  const visible: Array<{ link: RebaseCopyLink; source: RebaseLinkRow; target: RebaseLinkRow }> = [];
  for (const link of links) {
    const source = rowsByHash.get(link.sourceHash);
    const target = rowsByHash.get(link.targetHash);
    if (!source || !target) continue;
    const first = Math.min(source.index, target.index);
    const last = Math.max(source.index, target.index);
    if (last < range.start || first > range.end) continue;
    visible.push({ link, source, target });
  }
  return visible;
}

export function RebaseCopyLinksOverlay({
  renderedRange,
  links,
  entries,
  layoutRows,
  gutterWidth,
  graphViewportWidth,
  graphScrollLeft,
  rowHeightFor,
}: {
  /**
   * Indices of the rows the virtualizer has rendered, or null before it has
   * measured the scroll element (first mount, or the tab was hidden). The
   * links are laid out for the whole list, so without this gate they would
   * paint on an otherwise empty list until the rows arrive a frame later.
   */
  renderedRange: RowRange | null;
  links: RebaseCopyLink[];
  entries: GraphEntry[];
  layoutRows: GraphRow[];
  gutterWidth: number;
  graphViewportWidth: number;
  graphScrollLeft: number;
  rowHeightFor: (entry: GraphEntry) => number;
}) {
  const markerId = useId();
  if (links.length === 0 || !renderedRange) return null;

  const { rowsByHash, totalHeight } = layoutRebaseLinkRows(entries, layoutRows, rowHeightFor);
  const visibleLinks = rebaseLinksInRange(links, rowsByHash, renderedRange);
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
    <div
      className="pointer-events-none absolute top-0 left-0 z-20 overflow-hidden"
      style={{ width: 12 + graphViewportWidth, height: totalHeight }}
      data-testid="graph-rebase-copy-links"
    >
      <svg
        style={{
          width,
          height: totalHeight,
          overflow: 'visible',
          transform: `translateX(-${graphScrollLeft}px)`,
        }}
        width={width}
        height={totalHeight}
        aria-hidden="true"
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
            <g key={`${link.event?.id ?? 'copy'}:${link.sourceHash}:${link.targetHash}`}>
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
    </div>
  );
}
