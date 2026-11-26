import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { ok } from 'neverthrow';

const revertOptimisticRun = vi.fn();
const rollbackOptimisticMessage = vi.fn();
mock.module('@/components/ui/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
mock.module('@/stores/thread-store', () => ({
  useThreadStore: { getState: () => ({ revertOptimisticRun, rollbackOptimisticMessage }) },
}));

// A namespace import: the file still loads where `handleSendResult` is not exported.
import * as handlers from '@/components/thread/use-thread-handlers';
import { getQueueStore, readQueuedCount } from '@/data/queue/store';
import type { SendMessageResponse } from '@/lib/api/threads';

import { installTestDataLayer, resetTestDataLayer } from '../../helpers/data-layer-harness';

const t = (key: string) => key;

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('reportSendFailure', () => {
  test('undoes the running mark of the send that set it', () => {
    handlers.reportSendFailure({ type: 'INTERNAL', message: 'x' }, 't1', t);
    expect(revertOptimisticRun).toHaveBeenCalledWith('t1');
  });

  test('leaves a run alone when this send did not mark it (the thread was already running)', () => {
    handlers.reportSendFailure({ type: 'INTERNAL', message: 'x' }, 't1', t, false);
    expect(revertOptimisticRun).not.toHaveBeenCalled();
  });
});

describe('handleSendResult, queued send', () => {
  const send = (value: SendMessageResponse, rollbackOnQueue = true) => {
    expect(handlers.handleSendResult).toBeInstanceOf(Function);
    handlers.handleSendResult(ok(value), 't1', { rollbackOnQueue }, t);
  };

  test('a numeric queuedCount updates the queue count and drops the optimistic bubble', () => {
    send({ ok: true, queued: true, queuedCount: 3, queuedMessageId: 'q1' });
    expect(readQueuedCount('t1')).toBe(3);
    expect(rollbackOptimisticMessage).toHaveBeenCalledWith('t1');
  });

  test('a queued response without a count leaves the queue alone', () => {
    send({ ok: true, queued: true });
    expect(getQueueStore().getSynced('t1')).toBeUndefined();
    expect(rollbackOptimisticMessage).toHaveBeenCalledWith('t1');
  });

  test('a non-numeric queuedCount from the wire leaves the queue alone', () => {
    // The body is runner JSON: the declared type is not a runtime guarantee.
    send(JSON.parse('{"ok":true,"queued":true,"queuedCount":"3"}'));
    expect(getQueueStore().getSynced('t1')).toBeUndefined();
  });

  test('a send that was not queued does not touch the queue', () => {
    send({ ok: true, queuedCount: 3 }, false);
    expect(getQueueStore().getSynced('t1')).toBeUndefined();
    expect(rollbackOptimisticMessage).not.toHaveBeenCalled();
  });
});
