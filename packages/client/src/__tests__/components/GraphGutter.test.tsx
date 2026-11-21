import { describe, expect, test } from 'bun:test';

import { render } from '@testing-library/react';

import { GRAPH_NODE_RADIUS, GraphGutter } from '@/components/commit-graph/GraphGutter';
import type { GraphRow } from '@/lib/git-graph-lanes';

const row: GraphRow = { commitLane: 0, nodeColor: 0, segments: [] };

function nodeRadii(container: HTMLElement): string[] {
  return [...container.querySelectorAll('circle')].map((c) => c.getAttribute('r') ?? '');
}

describe('GraphGutter node', () => {
  test('keeps the same radius on a tall row (branch chips) as on a plain row', () => {
    const plain = render(
      <GraphGutter row={row} laneCount={1} height={22} authorName="Ada Lovelace" />,
    );
    const tall = render(
      <GraphGutter row={row} laneCount={1} height={80} authorName="Ada Lovelace" />,
    );
    const expected = String(GRAPH_NODE_RADIUS);
    expect(nodeRadii(plain.container).every((r) => r === expected)).toBe(true);
    expect(nodeRadii(tall.container).every((r) => r === expected)).toBe(true);
  });

  test('a distinct committer dashes the ring instead of adding a second circle', () => {
    const same = render(
      <GraphGutter row={row} laneCount={1} height={22} authorName="Ada Lovelace" />,
    );
    const distinct = render(
      <GraphGutter
        row={row}
        laneCount={1}
        height={22}
        authorName="Ada Lovelace"
        distinctCommitter
      />,
    );
    expect(nodeRadii(distinct.container)).toEqual(nodeRadii(same.container));
    expect(same.container.querySelector('circle[stroke-dasharray]')).toBeNull();
    expect(distinct.container.querySelector('circle[stroke-dasharray]')).not.toBeNull();
  });
});
