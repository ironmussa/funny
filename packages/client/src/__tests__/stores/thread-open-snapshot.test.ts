import { describe, expect, test } from 'bun:test';

import { newestActivity } from '@/data/thread-recap/activity';
import {
  recordThreadOpened,
  useThreadOpenStore,
  useThreadReadStore,
} from '@/stores/thread-read-store';

describe('recordThreadOpened', () => {
  test('keeps the read marker from before the open marks the thread read', () => {
    useThreadReadStore.getState().markRead('t-open', '2026-11-24T10:00:00.000Z');
    recordThreadOpened(
      't-open',
      { createdAt: null, newestMessageId: 'm2', newestActivityAt: '2026-11-24T11:00:00.000Z' },
      123,
    );
    useThreadReadStore.getState().markRead('t-open', '2026-11-24T11:30:00.000Z');

    expect(useThreadOpenStore.getState().byThread['t-open']).toEqual({
      readAt: '2026-11-24T10:00:00.000Z',
      openedAt: 123,
      createdAt: null,
      newestMessageId: 'm2',
      newestActivityAt: '2026-11-24T11:00:00.000Z',
    });
  });

  test('a thread never read records a null read marker', () => {
    recordThreadOpened('t-never', {
      createdAt: 'c',
      newestMessageId: null,
      newestActivityAt: null,
    });
    expect(useThreadOpenStore.getState().byThread['t-never']?.readAt).toBeNull();
  });
});

describe('newestActivity', () => {
  test('the newest message id, and the newest agent message or tool call time', () => {
    expect(
      newestActivity([
        { id: 'a', role: 'assistant', timestamp: '2026-11-24T10:00:00.000Z' },
        {
          id: 'b',
          role: 'assistant',
          timestamp: '2026-11-24T10:01:00.000Z',
          toolCalls: [{ timestamp: '2026-11-24T10:05:00.000Z' }],
        },
        { id: 'c', role: 'user', timestamp: '2026-11-24T10:09:00.000Z' },
      ]),
    ).toEqual({ newestMessageId: 'c', newestActivityAt: '2026-11-24T10:05:00.000Z' });
  });

  test('an empty payload or a window that is not the newest page says nothing', () => {
    const none = { newestMessageId: null, newestActivityAt: null };
    expect(newestActivity([])).toEqual(none);
    expect(
      newestActivity([{ id: 'a', role: 'assistant', timestamp: '2026-11-24T10:00:00.000Z' }], true),
    ).toEqual(none);
  });
});
