import { describe, expect, test } from 'bun:test';

import { createThreadMessagesSelector, subscribeSelector } from '../stores/selectors';
import { createThreadWorkspaceStore } from '../stores/thread-workspace';

const message = (id: string, threadId: string) => ({
  id,
  threadId,
  role: 'assistant' as const,
  content: id,
  timestamp: '2026-08-23T00:00:00Z',
});

describe('portable selectors', () => {
  test('keeps a thread message selection stable across unrelated thread updates', () => {
    const store = createThreadWorkspaceStore();
    store.getState().upsertDurableMessage('t1', message('m1', 't1'));
    const selector = createThreadMessagesSelector('t1');
    const first = selector(store.getState());
    store.getState().upsertDurableMessage('t2', message('m2', 't2'));
    expect(selector(store.getState())).toBe(first);
    store.getState().upsertDurableMessage('t1', message('m3', 't1'));
    expect(selector(store.getState())).not.toBe(first);
  });

  test('notifies selector subscribers only when their slice changes', () => {
    const store = createThreadWorkspaceStore();
    let calls = 0;
    const unsubscribe = subscribeSelector({
      store,
      selector: (state) => state.selectedThreadId,
      listener: () => {
        calls += 1;
      },
    });
    store.getState().setLoading('t1', true);
    store.getState().selectThread('t1');
    store.getState().setLoading('t2', true);
    store.getState().selectThread('t1');
    expect(calls).toBe(1);
    unsubscribe();
  });
});
