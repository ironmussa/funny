import type { Thread } from '@funny/shared';
import { describe, test, expect } from 'vitest';

import { applyThreadDataPatch, setThreadData, clearThreadData } from '@/stores/thread-mutations';
import type { ThreadState } from '@/stores/thread-state';
import type { ThreadWithMessages } from '@/stores/thread-types';

// Thread-row and list behavior (replace/append/prepend/remove/patch, archived
// preservation, stale-row reconciliation) moved to the data layer and is
// covered by __tests__/data/threads-*.test.ts.

function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: 'p1',
    title: `Thread ${id}`,
    status: 'completed',
    cost: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Thread;
}

function makeThreadWithMessages(id: string): ThreadWithMessages {
  return {
    ...makeThread(id),
    messages: [],
    hasMore: false,
  } as ThreadWithMessages;
}

function emptyState(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    selectedThreadId: null,
    threadDataById: {},
    activeThread: null,
    setupProgressByThread: {},
    contextUsageByThread: {},
    queuedCountByThread: {},
    queuedMessagesByThread: {},
    queuedNextMessageByThread: {},
    ...overrides,
  } as ThreadState;
}

describe('thread-mutations — threadDataById', () => {
  test('applyThreadDataPatch mirrors onto activeThread when selected', () => {
    const payload = makeThreadWithMessages('t1');
    payload.messages = [];
    const state = emptyState({
      selectedThreadId: 't1',
      threadDataById: { t1: payload },
      activeThread: payload,
    });

    const patch = applyThreadDataPatch(state, 't1', (t) => ({
      ...t,
      messages: [{ id: 'm1', threadId: 't1', role: 'user', content: 'hi' } as any],
    }));

    expect(patch.threadDataById!.t1.messages).toHaveLength(1);
    expect(patch.activeThread!.messages).toHaveLength(1);
  });

  test('applyThreadDataPatch returns {} when thread is not loaded', () => {
    expect(applyThreadDataPatch(emptyState(), 't1', (t) => ({ ...t, title: 'x' }))).toEqual({});
  });

  test('setThreadData inserts payload and mirrors active thread', () => {
    const payload = makeThreadWithMessages('t1');
    const state = emptyState({ selectedThreadId: 't1' });
    const patch = setThreadData(state, 't1', payload);

    expect(patch.threadDataById!.t1).toBe(payload);
    expect(patch.activeThread).toBe(payload);
  });

  test('clearThreadData drops payload and clears activeThread when selected', () => {
    const payload = makeThreadWithMessages('t1');
    const state = emptyState({
      selectedThreadId: 't1',
      threadDataById: { t1: payload },
      activeThread: payload,
    });

    const patch = clearThreadData(state, 't1');

    expect(patch.threadDataById!.t1).toBeUndefined();
    expect(patch.activeThread).toBeNull();
  });
});
