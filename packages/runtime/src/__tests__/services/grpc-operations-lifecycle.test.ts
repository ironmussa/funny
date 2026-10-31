import { FailureCode } from '@funny/shared/runner-v2/common';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../services/grpc-operation-outbox.js', () => ({
  GrpcOperationOutbox: class {
    enqueue = vi.fn();
    pending = vi.fn(() => []);
    markAttempt = vi.fn();
    confirm = vi.fn();
    close = vi.fn();
  },
}));

import { GrpcOperationOutbox } from '../../services/grpc-operation-outbox.js';
import { GrpcOperationsAdapter } from '../../services/grpc-operations-adapter.js';
import type { RunnerGrpcWireMessage } from '../../services/grpc-runner-client.js';

describe('GrpcOperationsAdapter request lifecycle', () => {
  let adapter: GrpcOperationsAdapter;
  let outbox: GrpcOperationOutbox;
  const send = vi.fn((_name: 'operations', _message: RunnerGrpcWireMessage) => true);
  const correlationId = () => send.mock.calls.at(-1)![1].metadata.correlationId;

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

  test('expires disconnected reads after 30 seconds and removes them from reconnect', async () => {
    send.mockReturnValue(false);
    const result = expect(adapter.request('data:get_thread', { threadId: 't1' })).rejects.toThrow(
      'timed out waiting for runner connection',
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    adapter.activated();
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('restarts the 15-second response deadline on each successful delivery', async () => {
    send.mockReturnValue(false);
    const result = expect(adapter.request('data:get_thread', {})).rejects.toThrow(
      'Data request timed out (data:get_thread)',
    );
    await vi.advanceTimersByTimeAsync(29_000);
    send.mockReturnValue(true);
    adapter.activated();
    await vi.advanceTimersByTimeAsync(14_000);
    adapter.activated();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    adapter.activated();
    expect(send).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(['success', 'missing', 'failure'] as const)('cleans up after %s', async (outcome) => {
    const request = adapter.request('data:get_thread', {});
    const message =
      outcome === 'success'
        ? { success: { thread: { value: { id: 't1' } } } }
        : {
            failure: {
              code: outcome === 'missing' ? FailureCode.NOT_FOUND : FailureCode.INTERNAL,
              message: 'failed',
            },
          };
    adapter.receive({ correlationId: correlationId(), ...message });
    if (outcome === 'failure') await expect(request).rejects.toThrow('failed');
    else
      await expect(request).resolves.toEqual({
        type: 'data:get_thread_response',
        thread: outcome === 'missing' ? null : { id: 't1' },
      });
    expect(vi.getTimerCount()).toBe(0);
    adapter.activated();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('rejects send errors without retaining a pending read or timer', async () => {
    const error = new Error('send failed');
    send.mockImplementationOnce(() => {
      throw error;
    });
    await expect(adapter.request('data:get_thread', {})).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
    adapter.activated();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('shutdown rejects every pending request and clears all timers', async () => {
    const first = expect(adapter.request('data:get_thread', {})).rejects.toThrow(
      'transport shut down',
    );
    const second = expect(adapter.request('data:get_project', {})).rejects.toThrow(
      'transport shut down',
    );
    adapter.shutdown();
    await Promise.all([first, second]);
    expect(vi.getTimerCount()).toBe(0);
    expect(outbox.close).toHaveBeenCalledOnce();
  });

  test('keeps timed-out mutations available for replay and confirms late outcomes', async () => {
    const result = expect(
      adapter.request('data:update_thread', {
        threadId: 't1',
        updates: { status: 'completed' },
      }),
    ).rejects.toThrow('Data request timed out');
    const original = send.mock.calls[0][1];
    const key = original.metadata.idempotencyKey;
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(outbox.confirm).not.toHaveBeenCalled();
    vi.mocked(outbox.pending).mockReturnValue([
      {
        idempotencyKey: key,
        operationKind: 'updateThread',
        payload: original.updateThread,
        createdAt: new Date().toISOString(),
        attemptCount: 1,
        lastAttemptAt: null,
      },
    ]);
    adapter.activated();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1].metadata.idempotencyKey).toBe(key);
    expect(vi.getTimerCount()).toBe(0);
    adapter.receive({ correlationId: original.metadata.correlationId, success: {} });
    expect(outbox.confirm).toHaveBeenCalledWith(key);
  });
});
