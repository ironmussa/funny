import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createSqliteDatabase, type DatabaseConnection } from '@funny/shared/db/connection';

import {
  resolveEventResumeCursors,
  SqlEventReceiptStore,
} from '../../services/grpc/event-receipts.js';

describe('SqlEventReceiptStore', () => {
  let connection: DatabaseConnection;

  beforeEach(() => {
    connection = createSqliteDatabase({ mode: 'sqlite', path: ':memory:' });
    connection.sqlite!.exec(`
      CREATE TABLE runner_event_receipts (
        runner_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        highest_contiguous_sequence TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (runner_id, execution_id)
      )
    `);
  });

  afterEach(() => connection.close());

  function createStore() {
    return new SqlEventReceiptStore({
      database: connection.db,
      transaction: async (work) => work(),
    });
  }

  test('answers many resume cursors with a fixed number of queries', async () => {
    const store = createStore();
    for (const executionId of ['execution-1', 'execution-2']) {
      const scope = { threadId: 'thread-1', executionId };
      await store.accept({ runnerId: 'runner-1', scope, sequence: 1n }, async () => {});
    }
    await store.accept(
      {
        runnerId: 'runner-1',
        scope: { threadId: 'thread-1', executionId: 'execution-2' },
        sequence: 2n,
      },
      async () => {},
    );
    // 1,200 cursors, most of them for executions the server never saw.
    const requested = Array.from({ length: 1_200 }, (_, index) => ({
      executionId: `execution-${index}`,
    }));
    let lookups = 0;
    const counting = {
      highestAcceptedMany: (runnerId: string, executionIds: string[]) => {
        lookups += 1;
        return store.highestAcceptedMany(runnerId, executionIds);
      },
    };

    const { cursors, dropped } = await resolveEventResumeCursors(counting, 'runner-1', requested);

    expect(lookups).toBe(1);
    expect(dropped).toBe(0);
    expect(cursors).toHaveLength(1_200);
    expect(cursors.slice(0, 3)).toEqual([
      { executionId: 'execution-0', lastAcceptedSequence: 0n },
      { executionId: 'execution-1', lastAcceptedSequence: 1n },
      { executionId: 'execution-2', lastAcceptedSequence: 2n },
    ]);
  });

  test("another runner's receipts are not answered", async () => {
    const store = createStore();
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };
    await store.accept({ runnerId: 'runner-1', scope, sequence: 1n }, async () => {});

    expect(await store.highestAcceptedMany('runner-2', ['execution-1'])).toEqual(new Map());
  });

  test('answers no more resume cursors than the limit', async () => {
    const requested = [
      { executionId: 'execution-1' },
      { executionId: 'execution-1' },
      { executionId: 'execution-2' },
      { executionId: 'execution-3' },
    ];

    const { cursors, dropped } = await resolveEventResumeCursors(
      createStore(),
      'runner-1',
      requested,
      2,
    );

    expect(cursors.map((cursor) => cursor.executionId)).toEqual(['execution-1', 'execution-2']);
    expect(dropped).toBe(1);
  });

  test('persists cumulative receipts and does not reapply duplicate events', async () => {
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };
    let applications = 0;
    const first = await createStore().accept(
      { runnerId: 'runner-1', scope, sequence: 1n },
      async () => {
        applications += 1;
      },
    );
    const duplicate = await createStore().accept(
      { runnerId: 'runner-1', scope, sequence: 1n },
      async () => {
        applications += 1;
      },
    );

    expect(first).toEqual({ kind: 'accepted', highestContiguousSequence: 1n });
    expect(duplicate).toEqual({ kind: 'duplicate', highestContiguousSequence: 1n });
    expect(await createStore().highestAccepted('runner-1', 'execution-1')).toBe(1n);
    expect(applications).toBe(1);
  });

  test('does not advance over a gap or when application fails', async () => {
    const store = createStore();
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };

    expect(
      await store.accept({ runnerId: 'runner-1', scope, sequence: 2n }, async () => {}),
    ).toEqual({ kind: 'out_of_order', highestContiguousSequence: 0n });
    await expect(
      store.accept({ runnerId: 'runner-1', scope, sequence: 1n }, async () => {
        throw new Error('apply failed');
      }),
    ).rejects.toThrow('apply failed');
    expect(await store.highestAccepted('runner-1', 'execution-1')).toBe(0n);
  });

  test('advances past unavailable history only after durable resynchronization', async () => {
    const store = createStore();
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };
    let resynchronizations = 0;

    expect(
      await store.resynchronize(
        { runnerId: 'runner-1', scope, missingThroughSequence: 4n },
        async () => {
          resynchronizations += 1;
        },
      ),
    ).toBe(4n);
    expect(
      await store.accept({ runnerId: 'runner-1', scope, sequence: 5n }, async () => {}),
    ).toEqual({ kind: 'accepted', highestContiguousSequence: 5n });
    expect(
      await store.resynchronize(
        { runnerId: 'runner-1', scope, missingThroughSequence: 4n },
        async () => {
          resynchronizations += 1;
        },
      ),
    ).toBe(5n);
    expect(resynchronizations).toBe(1);
  });

  test('does not advance a receipt when durable resynchronization fails', async () => {
    const store = createStore();
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };

    await expect(
      store.resynchronize({ runnerId: 'runner-1', scope, missingThroughSequence: 3n }, async () => {
        throw new Error('resync failed');
      }),
    ).rejects.toThrow('resync failed');
    expect(await store.highestAccepted('runner-1', 'execution-1')).toBe(0n);
  });

  test('rejects resynchronization when an execution belongs to another thread', async () => {
    const store = createStore();
    await store.accept(
      {
        runnerId: 'runner-1',
        scope: { threadId: 'thread-1', executionId: 'execution-1' },
        sequence: 1n,
      },
      async () => {},
    );
    let resynchronized = false;

    await expect(
      store.resynchronize(
        {
          runnerId: 'runner-1',
          scope: { threadId: 'thread-2', executionId: 'execution-1' },
          missingThroughSequence: 4n,
        },
        async () => {
          resynchronized = true;
        },
      ),
    ).rejects.toThrow('event execution is already assigned to another thread');
    expect(resynchronized).toBe(false);
    expect(await store.highestAccepted('runner-1', 'execution-1')).toBe(1n);
  });

  test('serializes concurrent delivery for one execution', async () => {
    const store = createStore();
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };
    const release = Promise.withResolvers<void>();
    const applied: bigint[] = [];
    const first = store.accept({ runnerId: 'runner-1', scope, sequence: 1n }, async () => {
      await release.promise;
      applied.push(1n);
    });
    const second = store.accept({ runnerId: 'runner-1', scope, sequence: 2n }, async () => {
      applied.push(2n);
    });

    await Bun.sleep(0);
    expect(applied).toEqual([]);
    release.resolve();
    expect(await first).toMatchObject({ kind: 'accepted', highestContiguousSequence: 1n });
    expect(await second).toMatchObject({ kind: 'accepted', highestContiguousSequence: 2n });
    expect(applied).toEqual([1n, 2n]);
  });

  test('scopes receipts by runner and rejects execution reuse across threads', async () => {
    const store = createStore();
    await store.accept(
      {
        runnerId: 'runner-1',
        scope: { threadId: 'thread-1', executionId: 'execution-1' },
        sequence: 1n,
      },
      async () => {},
    );

    expect(
      await store.accept(
        {
          runnerId: 'runner-1',
          scope: { threadId: 'thread-2', executionId: 'execution-1' },
          sequence: 2n,
        },
        async () => {},
      ),
    ).toEqual({ kind: 'out_of_order', highestContiguousSequence: 1n });
    expect(await store.highestAccepted('runner-2', 'execution-1')).toBe(0n);
  });

  describe('transient events', () => {
    function countingStore() {
      let transactions = 0;
      const store = new SqlEventReceiptStore({
        database: connection.db,
        transaction: async (work) => {
          transactions += 1;
          return work();
        },
      });
      return { store, transactions: () => transactions };
    }
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };
    const noop = async () => {};

    test('after the first receipt, advance without a transaction but persist every receipt', async () => {
      const { store, transactions } = countingStore();
      await store.accept({ runnerId: 'runner-1', scope, sequence: 1n, durable: false }, noop);
      expect(transactions()).toBe(1); // cold cache: read + write in a transaction

      for (const sequence of [2n, 3n, 4n]) {
        expect(
          await store.accept({ runnerId: 'runner-1', scope, sequence, durable: false }, noop),
        ).toEqual({ kind: 'accepted', highestContiguousSequence: sequence });
      }
      expect(transactions()).toBe(1);
      // Persisted each time: a fresh store (a restarted server) sees the latest receipt.
      expect(await createStore().highestAccepted('runner-1', 'execution-1')).toBe(4n);
    });

    test('duplicates and gaps are decided from the cached receipt without applying', async () => {
      const { store } = countingStore();
      let applied = 0;
      const apply = async () => {
        applied += 1;
      };
      await store.accept({ runnerId: 'runner-1', scope, sequence: 1n, durable: false }, apply);
      expect(
        await store.accept({ runnerId: 'runner-1', scope, sequence: 1n, durable: false }, apply),
      ).toEqual({ kind: 'duplicate', highestContiguousSequence: 1n });
      expect(
        await store.accept({ runnerId: 'runner-1', scope, sequence: 3n, durable: false }, apply),
      ).toEqual({ kind: 'out_of_order', highestContiguousSequence: 1n });
      expect(applied).toBe(1);
      expect(await createStore().highestAccepted('runner-1', 'execution-1')).toBe(1n);
    });

    test('durable events keep the transaction and continue the cached sequence', async () => {
      const { store, transactions } = countingStore();
      await store.accept({ runnerId: 'runner-1', scope, sequence: 1n, durable: false }, noop);
      await store.accept({ runnerId: 'runner-1', scope, sequence: 2n, durable: false }, noop);
      expect(await store.accept({ runnerId: 'runner-1', scope, sequence: 3n }, noop)).toEqual({
        kind: 'accepted',
        highestContiguousSequence: 3n,
      });
      expect(transactions()).toBe(2);
      expect(await createStore().highestAccepted('runner-1', 'execution-1')).toBe(3n);
    });

    test('a failed apply does not advance the cached or persisted receipt', async () => {
      const { store } = countingStore();
      await store.accept({ runnerId: 'runner-1', scope, sequence: 1n, durable: false }, noop);
      await expect(
        store.accept({ runnerId: 'runner-1', scope, sequence: 2n, durable: false }, async () => {
          throw new Error('apply failed');
        }),
      ).rejects.toThrow('apply failed');
      expect(
        await store.accept({ runnerId: 'runner-1', scope, sequence: 2n, durable: false }, noop),
      ).toEqual({ kind: 'accepted', highestContiguousSequence: 2n });
    });

    test('an execution cached for one thread is still refused for another', async () => {
      const { store } = countingStore();
      await store.accept({ runnerId: 'runner-1', scope, sequence: 1n, durable: false }, noop);
      expect(
        await store.accept(
          {
            runnerId: 'runner-1',
            scope: { threadId: 'thread-2', executionId: 'execution-1' },
            sequence: 2n,
            durable: false,
          },
          noop,
        ),
      ).toEqual({ kind: 'out_of_order', highestContiguousSequence: 1n });
    });
  });
});
