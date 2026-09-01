import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { GrpcOperationOutbox } from '../../services/grpc-operation-outbox.js';

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
});
