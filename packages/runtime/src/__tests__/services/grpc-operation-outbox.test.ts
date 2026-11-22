import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  GrpcOperationOutbox,
  OUTBOX_ENTRY_TTL_MS,
  OUTBOX_MAX_ATTEMPTS,
  type OutboxDropReason,
} from '../../services/grpc-operation-outbox.js';

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { force: true });
});

function temporaryPath(): string {
  const path = resolve(tmpdir(), `funny-grpc-outbox-${crypto.randomUUID()}.db`);
  paths.push(path, `${path}-wal`, `${path}-shm`);
  return path;
}

describe('GrpcOperationOutbox', () => {
  test('survives a runner restart with the original idempotency key and payload', () => {
    const path = temporaryPath();
    const first = new GrpcOperationOutbox(path);
    first.enqueue({
      idempotencyKey: 'mutation-1',
      operationKind: 'insertMessage',
      payload: { threadId: 'thread-1', content: 'hello' },
      createdAt: '2026-08-31T00:00:00.000Z',
    });
    first.markAttempt('mutation-1', '2026-08-31T00:00:01.000Z');
    first.close();

    const restarted = new GrpcOperationOutbox(path);
    expect(restarted.pending()).toEqual([
      {
        idempotencyKey: 'mutation-1',
        operationKind: 'insertMessage',
        payload: { threadId: 'thread-1', content: 'hello' },
        createdAt: '2026-08-31T00:00:00.000Z',
        attemptCount: 1,
        lastAttemptAt: '2026-08-31T00:00:01.000Z',
      },
    ]);
    restarted.close();
  });

  test('keeps identical enqueue retries but rejects conflicting key reuse', () => {
    const outbox = new GrpcOperationOutbox(':memory:');
    const input = {
      idempotencyKey: 'mutation-1',
      operationKind: 'updateThread',
      payload: { threadId: 'thread-1', status: 'completed' },
    };

    outbox.enqueue(input);
    outbox.enqueue({
      ...input,
      payload: { status: 'completed', threadId: 'thread-1' },
    });
    expect(outbox.pending()).toHaveLength(1);
    expect(() => outbox.enqueue({ ...input, payload: { threadId: 'thread-2' } })).toThrow(
      'idempotency key is already queued for a different mutation',
    );
    outbox.close();
  });

  test('resolves competing writers atomically without replacing the first mutation', () => {
    const path = temporaryPath();
    const first = new GrpcOperationOutbox(path);
    const second = new GrpcOperationOutbox(path);

    first.enqueue({
      idempotencyKey: 'shared-key',
      operationKind: 'updateThread',
      payload: { threadId: 'thread-1' },
      createdAt: '2026-08-31T00:00:00.000Z',
    });
    expect(() =>
      second.enqueue({
        idempotencyKey: 'shared-key',
        operationKind: 'updateThread',
        payload: { threadId: 'thread-2' },
      }),
    ).toThrow('idempotency key is already queued for a different mutation');
    expect(second.get('shared-key')?.payload).toEqual({ threadId: 'thread-1' });

    second.close();
    first.close();
  });

  test('rejects payload values that JSON persistence would silently change', () => {
    const outbox = new GrpcOperationOutbox(':memory:');

    expect(() =>
      outbox.enqueue({
        idempotencyKey: 'undefined-value',
        operationKind: 'updateThread',
        payload: { status: undefined },
      }),
    ).toThrow('payload.status must contain only durable JSON values');
    expect(() =>
      outbox.enqueue({
        idempotencyKey: 'non-finite-value',
        operationKind: 'updateThread',
        payload: { progress: Number.NaN },
      }),
    ).toThrow('payload.progress must contain only finite JSON numbers');
    expect(outbox.pending()).toEqual([]);
    outbox.close();
  });

  test('resumes a FIFO backlog in bounded pages after reconnect', () => {
    const path = temporaryPath();
    const first = new GrpcOperationOutbox(path);
    for (let index = 0; index < 5; index += 1) {
      first.enqueue({
        idempotencyKey: `mutation-${index}`,
        operationKind: 'insertMessage',
        payload: { index },
        createdAt: `2026-08-31T00:00:0${index}.000Z`,
      });
    }
    first.close();

    const reconnected = new GrpcOperationOutbox(path);
    expect(reconnected.pending(2).map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      'mutation-0',
      'mutation-1',
    ]);
    reconnected.confirm('mutation-0');
    reconnected.confirm('mutation-1');
    expect(reconnected.pending(2).map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      'mutation-2',
      'mutation-3',
    ]);
    reconnected.close();
  });

  test('removes an entry only after its application outcome is confirmed', () => {
    const outbox = new GrpcOperationOutbox(':memory:');
    outbox.enqueue({ idempotencyKey: 'mutation-1', operationKind: 'insertMessage', payload: {} });

    expect(outbox.confirm('unknown')).toBe(false);
    expect(outbox.get('mutation-1')).not.toBeNull();
    expect(outbox.confirm('mutation-1')).toBe(true);
    expect(outbox.get('mutation-1')).toBeNull();
    outbox.close();
  });

  // Issue #206: replay must page past 100 rows, drop stale rows, and survive a bad row.
  describe('replayable', () => {
    const NOW = Date.parse('2026-08-31T12:00:00.000Z');
    const at = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();

    test('pages through the whole backlog in FIFO order', () => {
      const outbox = new GrpcOperationOutbox(':memory:');
      for (let index = 0; index < 250; index += 1) {
        outbox.enqueue({
          idempotencyKey: `mutation-${String(index).padStart(3, '0')}`,
          operationKind: 'insertMessage',
          payload: { index },
          createdAt: at(60_000),
        });
      }

      const keys = [...outbox.replayable({ now: NOW, pageSize: 100 })].map(
        (item) => item.idempotencyKey,
      );
      expect(keys).toHaveLength(250);
      expect(keys[0]).toBe('mutation-000');
      expect(keys[249]).toBe('mutation-249');
      expect(new Set(keys).size).toBe(250);
      outbox.close();
    });

    test('drops rows past the TTL or the attempt cap instead of replaying them', () => {
      const outbox = new GrpcOperationOutbox(':memory:');
      outbox.enqueue({
        idempotencyKey: 'expired',
        operationKind: 'insertMessage',
        payload: {},
        createdAt: at(OUTBOX_ENTRY_TTL_MS + 1),
      });
      outbox.enqueue({
        idempotencyKey: 'exhausted',
        operationKind: 'insertMessage',
        payload: {},
        createdAt: at(1_000),
      });
      for (let attempt = 0; attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) {
        outbox.markAttempt('exhausted');
      }
      outbox.enqueue({
        idempotencyKey: 'fresh',
        operationKind: 'insertMessage',
        payload: {},
        createdAt: at(1_000),
      });

      const dropped: Array<[string, OutboxDropReason]> = [];
      const keys = [
        ...outbox.replayable({ now: NOW, onDropped: (key, reason) => dropped.push([key, reason]) }),
      ].map((item) => item.idempotencyKey);

      expect(keys).toEqual(['fresh']);
      expect(dropped).toEqual([
        ['expired', 'expired'],
        ['exhausted', 'attempts-exhausted'],
      ]);
      expect(outbox.get('expired')).toBeNull();
      expect(outbox.get('exhausted')).toBeNull();
      outbox.close();
    });

    test('keeps replaying past a corrupt row and removes it', () => {
      const path = temporaryPath();
      const outbox = new GrpcOperationOutbox(path);
      for (const key of ['a', 'c']) {
        outbox.enqueue({
          idempotencyKey: key,
          operationKind: 'insertMessage',
          payload: { key },
          createdAt: at(1_000),
        });
      }
      const raw = new Database(path);
      raw
        .query(
          `INSERT INTO grpc_operation_outbox (idempotency_key, operation_kind, payload_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run('b', 'insertMessage', '{not json', at(1_000));
      raw.close();

      const dropped: string[] = [];
      const keys = [
        ...outbox.replayable({ now: NOW, pageSize: 1, onDropped: (key) => dropped.push(key) }),
      ].map((item) => item.idempotencyKey);

      expect(keys).toEqual(['a', 'c']);
      expect(dropped).toEqual(['b']);
      expect(outbox.pending()).toHaveLength(2);
      outbox.close();
    });
  });
});
