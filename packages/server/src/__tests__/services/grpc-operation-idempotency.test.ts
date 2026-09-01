import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createSqliteDatabase, type DatabaseConnection } from '@funny/shared/db/connection';

import { SqlOperationIdempotencyStore } from '../../services/grpc/operation-idempotency.js';

describe('SqlOperationIdempotencyStore', () => {
  let connection: DatabaseConnection;

  beforeEach(() => {
    connection = createSqliteDatabase({ mode: 'sqlite', path: ':memory:' });
    connection.sqlite!.exec(`
      CREATE TABLE runner_operation_idempotency (
        runner_id TEXT NOT NULL,
        operation_kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (runner_id, operation_kind, idempotency_key)
      )
    `);
  });

  afterEach(() => connection.close());

  function createStore(now?: () => Date) {
    return new SqlOperationIdempotencyStore({
      retentionMs: 1_000,
      database: connection.db,
      transaction: async (work) => work(),
      now,
    });
  }

  test('replays a canonical request outcome across store instances', async () => {
    const input = {
      runnerId: 'runner-1',
      operationKind: 'updateMessage',
      idempotencyKey: 'key-1',
      request: { messageId: 'message-1', content: 'updated' },
    };
    let executions = 0;
    const first = await createStore().execute<{ success: boolean; version?: number }>(
      input,
      async () => {
        executions += 1;
        return { success: true, version: 2 };
      },
    );
    const replay = await createStore().execute<{ success: boolean; version?: number }>(
      { ...input, request: { content: 'updated', messageId: 'message-1' } },
      async () => {
        executions += 1;
        return { success: false };
      },
    );

    expect(first).toEqual({ kind: 'executed', outcome: { success: true, version: 2 } });
    expect(replay).toEqual({ kind: 'replayed', outcome: { success: true, version: 2 } });
    expect(executions).toBe(1);
  });

  test('rejects conflicting reuse, including while the original request is in progress', async () => {
    const store = createStore();
    const release = Promise.withResolvers<void>();
    const original = store.execute(
      {
        runnerId: 'runner-1',
        operationKind: 'insertComment',
        idempotencyKey: 'key-1',
        request: { content: 'first' },
      },
      async () => {
        await release.promise;
        return { commentId: 'comment-1' };
      },
    );

    expect(
      await store.execute(
        {
          runnerId: 'runner-1',
          operationKind: 'insertComment',
          idempotencyKey: 'key-1',
          request: { content: 'different' },
        },
        async () => ({ commentId: 'comment-2' }),
      ),
    ).toEqual({ kind: 'conflict' });
    release.resolve();
    await original;

    expect(
      await createStore().execute(
        {
          runnerId: 'runner-1',
          operationKind: 'insertComment',
          idempotencyKey: 'key-1',
          request: { content: 'different' },
        },
        async () => ({ commentId: 'comment-2' }),
      ),
    ).toEqual({ kind: 'conflict' });
  });

  test('expires and cleans retained outcomes', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const store = createStore(() => now);
    await store.execute(
      {
        runnerId: 'runner-1',
        operationKind: 'updateMessage',
        idempotencyKey: 'key-1',
        request: { content: 'first' },
      },
      async () => ({ success: true }),
    );

    now = new Date('2026-01-01T00:00:02.000Z');
    expect(await store.cleanupExpired()).toBe(1);
    expect(await store.cleanupExpired()).toBe(0);
  });

  test('scopes the same key independently by runner and operation kind', async () => {
    const store = createStore();
    let executions = 0;
    const execute = async () => ({ execution: ++executions });

    await store.execute(
      {
        runnerId: 'runner-1',
        operationKind: 'updateMessage',
        idempotencyKey: 'shared-key',
        request: { content: 'same' },
      },
      execute,
    );
    await store.execute(
      {
        runnerId: 'runner-2',
        operationKind: 'updateMessage',
        idempotencyKey: 'shared-key',
        request: { content: 'same' },
      },
      execute,
    );
    await store.execute(
      {
        runnerId: 'runner-1',
        operationKind: 'insertComment',
        idempotencyKey: 'shared-key',
        request: { content: 'same' },
      },
      execute,
    );

    expect(executions).toBe(3);
  });

  test('removes the claim when execution fails so the mutation can be retried', async () => {
    const store = createStore();
    const input = {
      runnerId: 'runner-1',
      operationKind: 'updateMessage',
      idempotencyKey: 'retry-key',
      request: { content: 'updated' },
    };

    await expect(
      store.execute(input, async () => Promise.reject(new Error('failed'))),
    ).rejects.toThrow('failed');
    expect(await store.execute(input, async () => ({ success: true }))).toEqual({
      kind: 'executed',
      outcome: { success: true },
    });
  });

  test('keeps a completed mutation claimed when its outcome cannot be persisted', async () => {
    const store = createStore();
    const input = {
      runnerId: 'runner-1',
      operationKind: 'updateMessage',
      idempotencyKey: 'unsafe-outcome',
      request: { content: 'updated' },
    };

    await expect(store.execute(input, async () => undefined)).rejects.toThrow(
      'outcome is not JSON serializable',
    );
    expect(await createStore().execute(input, async () => ({ success: true }))).toEqual({
      kind: 'in_progress',
    });
  });
});
