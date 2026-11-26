/** The factory view's runs carry their lane's conflicts (openspec factory-lanes D7). */

import { describe, expect, test } from 'bun:test';

import { errAsync, okAsync } from 'neverthrow';

import type { FactoryLaneView } from '../../services/factory/factory-lanes.js';
import { withLaneConflicts } from '../../trpc/ports/factory-port-lanes.js';

type Run = Parameters<typeof withLaneConflicts>[0][number];

const run = (id: string, factoryId: string, lane: string | null): Run => {
  // SAFETY: withLaneConflicts reads only id, factoryId and lane of a run.
  const partial: never = { id, factoryId, lane } as never;
  return partial;
};

const laneRow = (name: string, conflicts: FactoryLaneView['conflicts']): FactoryLaneView => {
  // SAFETY: withLaneConflicts reads only the name and conflicts of a lane.
  const partial: never = { name, conflicts } as never;
  return partial;
};

describe('withLaneConflicts', () => {
  test("gives a run in a lane its lane's conflicts, and leaves the others alone", async () => {
    const lists: string[] = [];
    const runs = await withLaneConflicts(
      [run('r1', 'f1', 'payments'), run('r2', 'f1', 'search'), run('r3', 'f1', null)],
      {
        list: (factoryId) => {
          lists.push(factoryId);
          return okAsync([
            laneRow('payments', [{ lane: 'search', paths: ['src/router.ts'] }]),
            laneRow('search', []),
          ]);
        },
      },
    );
    expect(runs.map((r) => r.laneConflicts)).toEqual([
      [{ lane: 'search', paths: ['src/router.ts'] }],
      undefined,
      undefined,
    ]);
    // One read per factory.
    expect(lists).toEqual(['f1']);
  });

  test('a lane read that fails leaves the runs as they are', async () => {
    const runs = [run('r1', 'f1', 'payments')];
    const out = await withLaneConflicts(runs, {
      list: () => errAsync({ kind: 'storage', message: 'down' }),
    });
    expect(out).toEqual(runs);
  });
});
