import type { Thread } from '@funny/shared';
import { okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createDataLayer } from '@/data/data-layer';
import { replaceDataLayer } from '@/data/runtime';
import { readThreadIndex } from '@/data/threads/read';
import { getThreadsData } from '@/data/threads/store';
import { useThreadStore } from '@/stores/thread-store';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

/**
 * Realtime events through the real thread store and WS handlers: row fields
 * land in the threads collection (canonical) and every projected view
 * follows (spec: *Realtime convergence*).
 */

const mockApi = vi.hoisted(() => ({
  listThreads: vi.fn(),
  getThread: vi.fn(),
  getThreadEvents: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: mockApi }));

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

beforeEach(async () => {
  vi.clearAllMocks();
  installTestDataLayer();
  useThreadStore.setState({ selectedThreadId: null, activeThread: null, threadDataById: {} });
  mockApi.listThreads.mockReturnValue(okAsync({ threads: [thread('t1')], total: 1 }));
  await useThreadStore.getState().loadThreadsForProject('p1');
});
afterEach(() => {
  vi.useRealTimers();
  resetTestDataLayer();
});

describe('realtime row updates', () => {
  test('spec: agent status change shows in the sidebar index and the board rows', () => {
    useThreadStore.getState().handleWSStatus('t1', { status: 'running' });

    expect(readThreadIndex().threadsById.t1.status).toBe('running');
    expect(getThreadsData().readThread('t1')?.status).toBe('running');
    expect(getThreadsData().getSynced('t1')?.status).toBe('running');
  });

  test('assistant snippets update the row without a refetch', () => {
    useThreadStore.getState().handleWSMessage('t1', { role: 'assistant', content: 'hello there' });
    expect(getThreadsData().readThread('t1')?.lastAssistantMessage).toBe('hello there');
    expect(mockApi.listThreads).toHaveBeenCalledTimes(1);
  });

  test('spec: an event for an unloaded project creates no partial row and refreshes', async () => {
    vi.useFakeTimers();
    mockApi.listThreads.mockReturnValue(
      okAsync({ threads: [thread('t1'), thread('new-one', { status: 'running' })], total: 2 }),
    );

    useThreadStore.getState().handleWSStatus('new-one', { status: 'running' });
    expect(getThreadsData().readThread('new-one')).toBeUndefined();
    expect(readThreadIndex().threadsById['new-one']).toBeUndefined();

    // The debounced project refresh brings the complete row.
    await vi.runAllTimersAsync();
    expect(mockApi.listThreads).toHaveBeenCalledTimes(2);
    expect(getThreadsData().readThread('new-one')?.status).toBe('running');
  });
});

describe('projection', () => {
  test('a projection attached to a layer that already holds rows still sees their deletes', () => {
    // A raw change subscriber created without the initial state does not hear
    // deletes of rows it never saw (verified against @tanstack/db rc.1.2), so
    // the projection subscribes with `includeInitialState`. This guards the
    // observable requirement for a layer that already holds rows.
    const layer = createDataLayer({ userId: 'user-2' });
    const data = getThreadsData(layer);
    data.upsertFromServer([thread('a1'), thread('a2')], data.beginRequest());
    replaceDataLayer(layer);
    expect(Object.keys(readThreadIndex().threadsById).sort()).toEqual(['a1', 'a2']);

    data.removeRows(['a1']);
    expect(readThreadIndex().threadsById.a1).toBeUndefined();
    expect(readThreadIndex().threadsById.a2?.id).toBe('a2');
  });
});
