import type { VirtualItem } from '@tanstack/react-virtual';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { GraphEntry } from '@/components/commit-graph/graph-entry';
import {
  GraphCommitRow,
  type GraphCommitRowOwnProps,
  type GraphCommitRowSharedProps,
} from '@/components/commit-graph/GraphCommitRow';
import {
  RebaseCopyLinksOverlay,
  renderedRangeOf,
} from '@/components/commit-graph/RebaseCopyLinksOverlay';
import type { GraphView } from '@/components/commit-graph/use-graph-view';
import { LoadingState } from '@/components/ui/loading-state';
import type { GitRebaseReflogEventDTO } from '@/lib/api/git';
import { syncRunCounts } from '@/lib/git-sync-runs';

const NO_REBASE_EVENTS: GitRebaseReflogEventDTO[] = [];

/**
 * One commit row, memoized on what it shows. The virtualizer re-renders the
 * list synchronously on every scroll event; rows already on screen must not
 * re-render then, or the list falls behind the scroll and shows blank space
 * until it catches up. So every prop here is a value or a reference that
 * stays the same while only the scroll position changes (no per-render
 * objects or closures).
 */
const GraphCommitListRow = memo(function GraphCommitListRow({
  shared,
  onSelectHash,
  ...own
}: Omit<GraphCommitRowOwnProps, 'onSelect'> & {
  shared: GraphCommitRowSharedProps;
  onSelectHash: (hash: string | null) => void;
}) {
  const row: GraphCommitRowOwnProps = {
    ...own,
    onSelect: () => onSelectHash(own.selected ? null : own.entry.hash),
  };
  return <GraphCommitRow shared={shared} row={row} />;
});

/** The parts of the graph view the list reads. */
export type GraphCommitListView = Pick<
  GraphView,
  | 'displayEntries'
  | 'layout'
  | 'rebaseCopyLinks'
  | 'rebaseEventsByHash'
  | 'forkedFromRefLabelByHash'
  | 'rebaseParentRefLabelByHash'
  | 'parentLabelByHash'
  | 'inferredUnpulled'
>;

/** The virtualized commit rows, the rebase-copy links over them and the load-more sentinel. */
export function GraphCommitList({
  totalSize,
  virtualItems,
  view,
  rowProps,
  baseRowH,
  rowHeightFor,
  selectedHash,
  onSelectHash,
  githubAvatarBySha,
  avatarByEmail,
  unpushed,
  unpulled,
  lastWipRowIndex,
}: {
  /** The virtualizer's total height, read in its hook (see useGraphVirtualizer). */
  totalSize: number;
  virtualItems: VirtualItem[];
  view: GraphCommitListView;
  rowProps: GraphCommitRowSharedProps;
  baseRowH: number;
  rowHeightFor: (entry: GraphEntry) => number;
  selectedHash: string | null;
  onSelectHash: (hash: string | null) => void;
  githubAvatarBySha: Map<string, string>;
  avatarByEmail: Map<string, string>;
  unpushed: Set<string>;
  unpulled: Set<string>;
  lastWipRowIndex: number;
}) {
  const { t } = useTranslation();
  const { displayEntries, layout } = view;
  // Each run of unpushed / unpulled commits shows its size once, on its newest commit.
  const unpushedCounts = useMemo(
    () => syncRunCounts(displayEntries, unpushed),
    [displayEntries, unpushed],
  );
  const unpulledCounts = useMemo(
    () => syncRunCounts(displayEntries, new Set([...unpulled, ...view.inferredUnpulled])),
    [displayEntries, unpulled, view.inferredUnpulled],
  );
  return (
    <div
      style={{
        height: totalSize,
        width: '100%',
        position: 'relative',
      }}
    >
      <RebaseCopyLinksOverlay
        renderedRange={renderedRangeOf(virtualItems)}
        links={view.rebaseCopyLinks}
        entries={displayEntries}
        layoutRows={layout.rows}
        gutterWidth={rowProps.gutterWidth}
        graphViewportWidth={rowProps.graphViewportWidth}
        graphScrollLeft={rowProps.graphScrollLeft}
        rowHeightFor={rowHeightFor}
      />
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
                testId="graph-loading-more"
                label={t('history.loadingMore', 'Loading more…')}
              />
            </div>
          );
        }
        const entry = displayEntries[virtualRow.index];
        return (
          <GraphCommitListRow
            key={entry.hash}
            shared={rowProps}
            onSelectHash={onSelectHash}
            entry={entry}
            graphRow={layout.rows[virtualRow.index]}
            selected={selectedHash === entry.hash}
            avatarUrl={githubAvatarBySha.get(entry.hash) ?? avatarByEmail.get(entry.authorEmail)}
            committerAvatarUrl={avatarByEmail.get(entry.committerEmail)}
            rebaseEvents={view.rebaseEventsByHash.get(entry.hash) ?? NO_REBASE_EVENTS}
            forkedFromRefLabel={
              view.forkedFromRefLabelByHash.get(entry.hash) ??
              view.rebaseParentRefLabelByHash.get(entry.hash) ??
              null
            }
            parentLabel={view.parentLabelByHash.get(entry.hash) ?? null}
            unpushed={unpushed.has(entry.hash)}
            unpulled={unpulled.has(entry.hash) || view.inferredUnpulled.has(entry.hash)}
            unpushedCount={unpushedCounts.get(entry.hash)}
            unpulledCount={unpulledCounts.get(entry.hash)}
            connectToWip={virtualRow.index <= lastWipRowIndex}
            transform={virtualRow.start}
            rowHeight={rowHeightFor(entry)}
          />
        );
      })}
    </div>
  );
}
