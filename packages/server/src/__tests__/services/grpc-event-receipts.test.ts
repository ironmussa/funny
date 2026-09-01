import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createSqliteDatabase, type DatabaseConnection } from '@funny/shared/db/connection';

import { SqlEventReceiptStore } from '../../services/grpc/event-receipts.js';

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
});
