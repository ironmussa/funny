import { describe, test, expect } from 'vitest';

import { buildThreadWithMessages } from '@/data/threads/testing';
import { applyThreadDataPatch, setThreadData, clearThreadData } from '@/stores/thread-mutations';
import type { ThreadState } from '@/stores/thread-state';
import { useThreadStore } from '@/stores/thread-store';
import type { ThreadWithMessages } from '@/stores/thread-types';

import { buildMessage } from '../helpers/builders-stores';

// Thread-row and list behavior (replace/append/prepend/remove/patch, archived
// preservation, stale-row reconciliation) moved to the data layer and is
// covered by __tests__/data/threads-*.test.ts.

function makeThreadWithMessages(id: string): ThreadWithMessages {
  return buildThreadWithMessages({ id, title: `Thread ${id}` });
}

function emptyState(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    ...useThreadStore.getInitialState(),
    selectedThreadId: null,
    threadDataById: {},
    activeThread: null,
    setupProgressByThread: {},
    ...overrides,
  };
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
      messages: [buildMessage({ id: 'm1', threadId: 't1', role: 'user', content: 'hi' })],
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
