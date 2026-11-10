import type { QueuedMessage } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/api/threads', () => ({
  threadsApi: {
    listQueue: vi.fn(),
    updateQueuedMessage: vi.fn(),
    cancelQueuedMessage: vi.fn(),
  },
}));

import { cancelQueuedMessage, editQueuedMessage } from '@/data/queue/actions';
import {
  applyQueueCount,
  applyQueueSummary,
  getQueueStore,
  queueListQuery,
  queueNeedsLoad,
  readQueuedCount,
  removeQueuedMessage,
  seedQueueSummary,
} from '@/data/queue/store';
import { threadsApi } from '@/lib/api/threads';

import { deferred, installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const mockApi = vi.mocked(threadsApi);

const msg = (id: string, content: string, sortOrder = 0): QueuedMessage => ({
  id,
  threadId: 't1',
  content,
  sortOrder,
  createdAt: '',
});

const row = () => getQueueStore().getSynced('t1');

/** Run the composer's list fetch for the row's current rev. */
async function loadList() {
  const { queryFn } = queueListQuery('t1', row()!.rev);
  return queryFn();
}

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('queue summary', () => {
  test('a new summary needs a list load; the same summary again is a no-op', () => {
    applyQueueSummary('t1', 2, 'first');
    const first = row()!;
    expect(queueNeedsLoad(first)).toBe(true);

    applyQueueSummary('t1', 2, 'first');
    expect(row()).toBe(first);
  });

  test('an empty queue has nothing to load', () => {
    applyQueueSummary('t1', 2, 'first');
    applyQueueSummary('t1', 0, undefined);
    expect(row()).toMatchObject({ count: 0, messages: [] });
    expect(queueNeedsLoad(row())).toBe(false);
  });

  test('a count-only update (send response) keeps the known next message', () => {
    applyQueueSummary('t1', 1, 'first');
    applyQueueCount('t1', 2);
    expect(row()).toMatchObject({ count: 2, next: 'first' });
    expect(readQueuedCount('t1')).toBe(2);
  });

  test('a thread detail does not override a row the session already holds', () => {
    applyQueueSummary('t1', 3, 'from ws');
    seedQueueSummary('t1', 1, 'from a prefetched detail');
    expect(row()).toMatchObject({ count: 3, next: 'from ws' });

    seedQueueSummary('t2', 1, 'first');
    expect(getQueueStore().getSynced('t2')).toMatchObject({ count: 1, next: 'first' });
  });
});

describe('queue list', () => {
  test('a fetched list is recorded and the row is current', async () => {
    applyQueueSummary('t1', 2, 'first');
    mockApi.listQueue.mockReturnValue(okAsync([msg('a', 'first'), msg('b', 'second', 1)]));

    await loadList();

    expect(row()?.messages?.map((m) => m.id)).toEqual(['a', 'b']);
    expect(queueNeedsLoad(row())).toBe(false);
  });

  test('a list that returns after the summary moved on is dropped', async () => {
    applyQueueSummary('t1', 1, 'first');
    const response = deferred<QueuedMessage[]>();
    mockApi.listQueue.mockReturnValue(ResultAsync.fromSafePromise(response.promise));

    const pending = loadList();
    // The server dequeued that message and queued another before the list landed.
    applyQueueSummary('t1', 1, 'second');
    response.resolve([msg('a', 'first')]);
    await pending;

    expect(row()).toMatchObject({ count: 1, next: 'second' });
    expect(row()?.messages).toBeUndefined();
    expect(queueNeedsLoad(row())).toBe(true);
  });

  test('a failed fetch rejects and leaves the row to retry', async () => {
    applyQueueSummary('t1', 1, 'first');
    mockApi.listQueue.mockReturnValue(
      errAsync({ type: 'INTERNAL', message: 'down' } as DomainError),
    );

    await expect(loadList()).rejects.toThrow('down');
    expect(queueNeedsLoad(row())).toBe(true);
  });
});

describe('queue edits', () => {
  beforeEach(async () => {
    applyQueueSummary('t1', 2, 'first');
    mockApi.listQueue.mockReturnValue(okAsync([msg('a', 'first'), msg('b', 'second', 1)]));
    await loadList();
  });

  test('a confirmed edit updates the message and the next preview', async () => {
    mockApi.updateQueuedMessage.mockReturnValue(okAsync({ ok: true } as never));
    await editQueuedMessage('t1', 'a', 'edited');
    expect(row()).toMatchObject({ next: 'edited' });
    expect(row()?.messages?.[0]?.content).toBe('edited');
  });

  test('a confirmed cancel removes the message without a refetch', async () => {
    mockApi.cancelQueuedMessage.mockReturnValue(okAsync({ ok: true, queuedCount: 1 }));
    await cancelQueuedMessage('t1', 'a');
    expect(row()).toMatchObject({ count: 1, next: 'second' });
    expect(row()?.messages?.map((m) => m.id)).toEqual(['b']);
    expect(queueNeedsLoad(row())).toBe(false);
  });

  test('cancelling the last message empties the queue', () => {
    removeQueuedMessage('t1', 'a', 0);
    expect(row()).toMatchObject({ count: 0, messages: [] });
  });

  test('a failed edit leaves the row untouched', async () => {
    const before = row();
    mockApi.updateQueuedMessage.mockReturnValue(
      errAsync({ type: 'INTERNAL', message: 'nope' } as DomainError),
    );
    const result = await editQueuedMessage('t1', 'a', 'edited');
    expect(result.isErr()).toBe(true);
    expect(row()).toBe(before);
  });
});

test('a new session starts without queues', () => {
  applyQueueSummary('t1', 1, 'first');
  installTestDataLayer('user-2');
  expect(row()).toBeUndefined();
});
