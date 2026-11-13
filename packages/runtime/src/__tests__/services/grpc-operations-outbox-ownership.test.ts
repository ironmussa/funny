import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { GrpcOperationOutbox } from '../../services/grpc-operation-outbox.js';
import { GrpcOperationsAdapter } from '../../services/grpc-operations-adapter.js';
import type { RunnerGrpcWireMessage } from '../../services/grpc-runner-client.js';

// Issue #193: a mutation whose caller was told it failed must not be replayed
// by the outbox on the next reconnect (a "ghost write").
describe('GrpcOperationsAdapter outbox ownership', () => {
  let adapter: GrpcOperationsAdapter;
  let outbox: GrpcOperationOutbox;
  const send = vi.fn((_name: 'operations', _message: RunnerGrpcWireMessage) => true);
  const update = () =>
    adapter.request('data:update_thread', { threadId: 't1', updates: { status: 'completed' } });

  beforeEach(() => {
    vi.useFakeTimers();
    send.mockReset().mockReturnValue(true);
    outbox = new GrpcOperationOutbox(':memory:');
    adapter = new GrpcOperationsAdapter({ send }, outbox);
  });

  afterEach(() => {
    adapter.shutdown();
    vi.useRealTimers();
  });

  test('a mutation that timed out after delivery is not replayed on reconnect', async () => {
    const result = expect(update()).rejects.toThrow('Data request timed out');
    await vi.advanceTimersByTimeAsync(15_000);
    await result;

    expect(outbox.pending()).toEqual([]);
    adapter.activated();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('a mutation that timed out waiting for a connection is never sent', async () => {
    send.mockReturnValue(false);
    const result = expect(update()).rejects.toThrow('timed out waiting for runner connection');
    await vi.advanceTimersByTimeAsync(30_000);
    await result;

    expect(outbox.pending()).toEqual([]);
    send.mockReturnValue(true);
    adapter.activated();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('a mutation whose send threw is not replayed', async () => {
    send.mockImplementationOnce(() => {
      throw new Error('send failed');
    });
    await expect(update()).rejects.toThrow('send failed');

    expect(outbox.pending()).toEqual([]);
  });

  test('a late reply to a timed-out mutation is ignored', async () => {
    const result = expect(update()).rejects.toThrow('Data request timed out');
    const correlationId = send.mock.calls[0][1].metadata.correlationId;
    await vi.advanceTimersByTimeAsync(15_000);
    await result;

    expect(() => adapter.receive({ correlationId, success: {} })).not.toThrow();
    expect(outbox.pending()).toEqual([]);
  });

  test('a mutation still awaiting its outcome stays in the outbox and is resent', async () => {
    send.mockReturnValue(false);
    const request = update();
    expect(outbox.pending()).toHaveLength(1);

    send.mockReturnValue(true);
    adapter.activated();
    const key = send.mock.calls.at(-1)![1].metadata.idempotencyKey;
    const correlationId = send.mock.calls.at(-1)![1].metadata.correlationId;
    adapter.receive({ correlationId, success: {} });
    await expect(request).resolves.toEqual({ success: true });
    expect(outbox.get(key)).toBeNull();
  });

  test('rows left by a previous process are still replayed', () => {
    outbox.enqueue({
      idempotencyKey: 'crashed-key',
      operationKind: 'updateThread',
      payload: { threadId: 't1', updates: { status: 'completed' } },
    });
    adapter.activated();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1].metadata.idempotencyKey).toBe('crashed-key');
  });
});
