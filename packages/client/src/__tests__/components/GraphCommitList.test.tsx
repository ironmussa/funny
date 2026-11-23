import { describe, expect, mock, test } from 'bun:test';

import type { VirtualItem } from '@tanstack/react-virtual';
import { render } from '@testing-library/react';

import type { GraphEntry } from '@/components/commit-graph/graph-entry';
import type { GraphCommitListView } from '@/components/commit-graph/GraphCommitList';
import type { GraphCommitRowSharedProps } from '@/components/commit-graph/GraphCommitRow';

// Count row renders: a row already on screen must not re-render when the list
// only scrolls (the virtualizer re-renders the list on every scroll event, and
// re-rendering every visible row made the History list paint blank while it
// caught up).
const rowRenders = new Map<string, number>();
mock.module('@/components/commit-graph/GraphCommitRow', () => ({
  GraphCommitRow: ({ row }: { row: { entry: GraphEntry; onSelect: () => void } }) => {
    rowRenders.set(row.entry.hash, (rowRenders.get(row.entry.hash) ?? 0) + 1);
    return (
      <button data-testid={`row-${row.entry.hash}`} onClick={row.onSelect}>
        {row.entry.message}
      </button>
    );
  },
}));
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const { GraphCommitList } = await import('@/components/commit-graph/GraphCommitList');

const ROW_H = 30;

function entry(i: number): GraphEntry {
  return {
    hash: `h${i}`,
    shortHash: `h${i}`,
    author: 'a',
    authorEmail: 'a@x',
    authoredAt: 0,
    committer: 'a',
    committerEmail: 'a@x',
    committedAt: '2026-01-01T00:00:00.000Z',
    message: `commit ${i}`,
    body: '',
    parentHashes: [],
    refs: [],
    headBranch: null,
  };
}

const entries = Array.from({ length: 20 }, (_, i) => entry(i));

const view: GraphCommitListView = {
  displayEntries: entries,
  layout: { rows: [], laneCount: 1 },
  rebaseCopyLinks: [],
  rebaseEventsByHash: new Map(),
  forkedFromRefLabelByHash: new Map(),
  rebaseParentRefLabelByHash: new Map(),
  parentLabelByHash: new Map(),
  inferredUnpulled: new Set(),
};

const rowProps = {
  gutterWidth: 40,
  graphViewportWidth: 40,
  graphScrollLeft: 0,
} as GraphCommitRowSharedProps;

function items(from: number, to: number): VirtualItem[] {
  return Array.from({ length: to - from + 1 }, (_, k) => {
    const index = from + k;
    return {
      key: entries[index].hash,
      index,
      start: index * ROW_H,
      end: (index + 1) * ROW_H,
      size: ROW_H,
      lane: 0,
    };
  });
}

const emptyMap = new Map<string, string>();
const emptySet = new Set<string>();
const rowHeightFor = () => ROW_H;

function list(virtualItems: VirtualItem[], onSelectHash: (hash: string | null) => void) {
  return (
    <GraphCommitList
      totalSize={entries.length * ROW_H}
      virtualItems={virtualItems}
      view={view}
      rowProps={rowProps}
      baseRowH={ROW_H}
      rowHeightFor={rowHeightFor}
      selectedHash={null}
      onSelectHash={onSelectHash}
      githubAvatarBySha={emptyMap}
      avatarByEmail={emptyMap}
      unpushed={emptySet}
      unpulled={emptySet}
      lastWipRowIndex={-1}
    />
  );
}

describe('GraphCommitList', () => {
  test('scrolling renders only the rows that come into view', () => {
    rowRenders.clear();
    const onSelectHash = mock(() => {});
    const { rerender } = render(list(items(0, 9), onSelectHash));
    expect(rowRenders.get('h5')).toBe(1);

    // Scroll by two rows: h0/h1 leave, h10/h11 come in, h2..h9 stay.
    rerender(list(items(2, 11), onSelectHash));

    for (let i = 2; i <= 9; i++) expect(rowRenders.get(`h${i}`)).toBe(1);
    expect(rowRenders.get('h10')).toBe(1);
    expect(rowRenders.get('h11')).toBe(1);
  });

  test('a memoized row still toggles its own selection', () => {
    const onSelectHash = mock((_hash: string | null) => {});
    const { getByTestId } = render(list(items(0, 3), onSelectHash));

    getByTestId('row-h2').click();

    expect(onSelectHash).toHaveBeenCalledWith('h2');
  });
});
