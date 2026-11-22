import type { WheelEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { LANE_WIDTH } from '@/components/commit-graph/GraphGutter';
import { DiffStats } from '@/components/DiffStats';
import type { useWorkingTreeStatus } from '@/hooks/use-working-tree-status';
import type { GraphRow } from '@/lib/git-graph-lanes';
import { graphLanePastel } from '@/lib/graph-colors';
import { useUIStore } from '@/stores/ui-store';

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
  graphViewportWidth = gutterWidth,
  graphScrollLeft = 0,
  onGraphGutterWheel,
  rowHeight,
}: {
  status: NonNullable<ReturnType<typeof useWorkingTreeStatus>['status']>;
  firstRow: GraphRow | undefined;
  laneCount: number;
  gutterWidth: number;
  graphViewportWidth?: number;
  graphScrollLeft?: number;
  onGraphGutterWheel?: (event: WheelEvent<HTMLDivElement>) => void;
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
      <div
        style={{ width: graphViewportWidth }}
        className="shrink-0 self-stretch overflow-hidden"
        onWheel={onGraphGutterWheel}
      >
        <div style={{ width: gutterWidth, transform: `translateX(-${graphScrollLeft}px)` }}>
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
