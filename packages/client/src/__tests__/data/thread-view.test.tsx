import type { Thread } from '@funny/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { setSourceMembers } from '@/data/threads/list-meta';
import { adoptThreadDetail } from '@/data/threads/loaders';
import { isThreadListed, readThreadRow } from '@/data/threads/read';
import { getThreadsData } from '@/data/threads/store';
import { ThreadProvider, useActiveThreadView, useThreadCore } from '@/stores/thread-context';
import { patchThreadRow } from '@/stores/thread-row-writes';
import { useThreadStore, type ThreadWithMessages } from '@/stores/thread-store';
import { mergeThreadView, readActiveThreadView } from '@/stores/thread-view';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: 'p1',
    title: id,
    mode: 'local',
    status: 'idle',
    stage: 'backlog',
    cost: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Thread;
}

function payload(id: string, overrides: Partial<ThreadWithMessages> = {}): ThreadWithMessages {
  return { ...thread(id), messages: [], ...overrides } as ThreadWithMessages;
}

function openThread(entry: ThreadWithMessages): void {
  useThreadStore.setState({
    selectedThreadId: entry.id,
    activeThread: entry,
    threadDataById: { [entry.id]: entry },
  });
}

const inProvider =
  (threadId: string) =>
  ({ children }: { children: ReactNode }) => (
    <ThreadProvider threadId={threadId}>{children}</ThreadProvider>
  );

beforeEach(() => installTestDataLayer());
afterEach(() => {
  // Unmount first (resetTestDataLayer does): the hooks read this store.
  resetTestDataLayer();
  useThreadStore.setState({ selectedThreadId: null, activeThread: null, threadDataById: {} });
});

describe('mergeThreadView', () => {
  test('row fields win over the payload copy; payload fields are kept', () => {
    const entry = payload('t1', { title: 'old', totalMessages: 2 });
    const view = mergeThreadView(entry, thread('t1', { title: 'new', status: 'running' }));
    expect(view?.title).toBe('new');
    expect(view?.status).toBe('running');
    expect(view?.totalMessages).toBe(2);
    expect(view?.messages).toBe(entry.messages);
  });

  test('same (payload, row) pair → same object; no row → the payload itself', () => {
    const entry = payload('t1');
    const row = thread('t1', { title: 'x' });
    expect(mergeThreadView(entry, row)).toBe(mergeThreadView(entry, row));
    expect(mergeThreadView(entry, undefined)).toBe(entry);
    expect(mergeThreadView(entry, thread('other'))).toBe(entry);
    expect(mergeThreadView(null, row)).toBeNull();
  });
});

describe('detail view reads row fields from the collection', () => {
  test('spec: a rename (or any row change) reaches the open thread without a payload write', async () => {
    getThreadsData().upsertFresh([thread('t1', { title: 'before' })]);
    openThread(payload('t1', { title: 'before' }));

    const core = renderHook(() => useThreadCore(), { wrapper: inProvider('t1') });
    const active = renderHook(() => useActiveThreadView());
    expect(core.result.current?.title).toBe('before');

    act(() => {
      patchThreadRow('t1', (t) => ({ ...t, title: 'after', status: 'running' }));
    });
    await waitFor(() => expect(core.result.current?.title).toBe('after'));
    expect(core.result.current?.status).toBe('running');
    expect(active.result.current?.title).toBe('after');
    expect(readActiveThreadView(useThreadStore.getState())?.status).toBe('running');
    // The payload itself is not touched: the row is the only copy that moves.
    expect(useThreadStore.getState().activeThread?.title).toBe('before');
  });
});

describe('adoptThreadDetail', () => {
  test('a thread opened by URL gets a row without joining any list', () => {
    adoptThreadDetail({
      ...thread('deep', { title: 'Deep link' }),
      messages: [],
      hasMore: false,
    } as Thread);
    const row = readThreadRow('deep');
    expect(row?.title).toBe('Deep link');
    expect(row && 'messages' in row).toBe(false);
    expect(isThreadListed('deep')).toBe(false);
    expect(getThreadsData().meta.getState().members).toEqual({});
  });

  test('a held row wins over an older detail; the detail only fills missing fields', () => {
    getThreadsData().upsertFresh([thread('t1', { title: 'renamed live' })]);
    adoptThreadDetail(thread('t1', { title: 'stale cached', initialPrompt: 'hello' }));
    const row = readThreadRow('t1');
    expect(row?.title).toBe('renamed live');
    expect(row?.initialPrompt).toBe('hello');
  });
});

describe('isThreadListed', () => {
  test('true only for threads in a loaded list', () => {
    const data = getThreadsData();
    data.upsertFresh([thread('a'), thread('unlisted')]);
    setSourceMembers(data.meta, 'project:p1', ['a'], 1);
    expect(isThreadListed('a')).toBe(true);
    expect(isThreadListed('unlisted')).toBe(false);
    setSourceMembers(data.meta, 'scratch', ['unlisted'], 1);
    expect(isThreadListed('unlisted')).toBe(true);
  });
});
