import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';

import type { GraphEntry } from '@/components/commit-graph/graph-entry';
import { GraphCommitRow, type GraphCommitRowProps } from '@/components/commit-graph/GraphCommitRow';
import {
  RebaseCopyLinksOverlay,
  renderedRangeOf,
} from '@/components/commit-graph/RebaseCopyLinksOverlay';
import type { GraphView } from '@/components/commit-graph/use-graph-view';
import { LoadingState } from '@/components/ui/loading-state';

/** The row props every commit row shares; the list fills in the per-row ones. */
export type GraphCommitRowSharedProps = Omit<
  GraphCommitRowProps,
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
  | 'onSelect'
>;

/** The virtualized commit rows, the rebase-copy links over them and the load-more sentinel. */
export function GraphCommitList({
  virtualizer,
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
  virtualizer: Pick<Virtualizer<HTMLDivElement, Element>, 'getTotalSize'>;
  virtualItems: VirtualItem[];
  view: GraphView;
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
  return (
    <div
      style={{
        height: virtualizer.getTotalSize(),
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
          <GraphCommitRow
            key={entry.hash}
            {...rowProps}
            entry={entry}
            graphRow={layout.rows[virtualRow.index]}
            selected={selectedHash === entry.hash}
            avatarUrl={githubAvatarBySha.get(entry.hash) ?? avatarByEmail.get(entry.authorEmail)}
            committerAvatarUrl={avatarByEmail.get(entry.committerEmail)}
            rebaseEvents={view.rebaseEventsByHash.get(entry.hash) ?? []}
            forkedFromRefLabel={
              view.forkedFromRefLabelByHash.get(entry.hash) ??
              view.rebaseParentRefLabelByHash.get(entry.hash) ??
              null
            }
            parentLabel={view.parentLabelByHash.get(entry.hash) ?? null}
            unpushed={unpushed.has(entry.hash)}
            unpulled={unpulled.has(entry.hash) || view.inferredUnpulled.has(entry.hash)}
            connectToWip={virtualRow.index <= lastWipRowIndex}
            transform={virtualRow.start}
            rowHeight={rowHeightFor(entry)}
            onSelect={() => onSelectHash(selectedHash === entry.hash ? null : entry.hash)}
          />
        );
      })}
    </div>
  );
}
