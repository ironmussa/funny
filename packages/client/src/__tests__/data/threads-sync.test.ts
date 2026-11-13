import type { Thread } from '@funny/shared';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { DataLayer } from '@/data/data-layer';
import { setDataLayerSession, getDataLayer } from '@/data/runtime';
import { archiveThread, moveThreadStage, unarchiveThread } from '@/data/threads/actions';
import {
  addScratchThread,
  applyThreadDetail,
  beginThreadRequest,
  loadMoreProjectThreads,
  loadProjectThreads,
  loadSharedThreads,
  removeThreadLocally,
} from '@/data/threads/loaders';
import { getThreadsData } from '@/data/threads/store';

import { deferred, installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const mockApi = vi.hoisted(() => ({
  listThreads: vi.fn(),
  listScratchThreads: vi.fn(),
  listSharedWithMe: vi.fn(),
  archiveThread: vi.fn(),
  updateThreadStage: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: mockApi }));

const emitted = vi.hoisted(() => [] as unknown[]);
vi.mock('@/platform/client-composition', () => ({
  clientComposition: { platform: { effects: { emit: (effect: unknown) => emitted.push(effect) } } },
}));

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

/** An API call whose response the test releases by hand. */
function gatedCall<T>() {
  const gate = deferred<T>();
  return {
    result: ResultAsync.fromSafePromise(gate.promise),
    release: gate.resolve,
  };
}

let layer: DataLayer;
beforeEach(() => {
  vi.clearAllMocks();
  emitted.length = 0;
  layer = installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

const data = () => getThreadsData(layer);
const visible = (id: string) => data().readThread(id);
const members = (source: 'project:p1' | 'scratch' | 'shared') =>
  data().meta.getState().members[source];

describe('loaders', () => {
  test('concurrent loads of the same list issue one request', async () => {
    const call = gatedCall<{ threads: Thread[]; total: number }>();
    mockApi.listThreads.mockReturnValue(call.result);

    const a = loadProjectThreads('p1');
    const b = loadProjectThreads('p1');
    call.release({ threads: [thread('t1')], total: 1 });
    await Promise.all([a, b]);

    expect(mockApi.listThreads).toHaveBeenCalledTimes(1);
    expect(members('project:p1')).toEqual(['t1']);
  });

  test('an unloaded project has no members, which differs from an empty list', async () => {
    expect(members('project:p1')).toBeUndefined();
    mockApi.listThreads.mockReturnValue(okAsync({ threads: [], total: 0 }));
    await loadProjectThreads('p1');
    expect(members('project:p1')).toEqual([]);
  });

  test('load more appends the next page at offset = listed rows', async () => {
    mockApi.listThreads.mockReturnValueOnce(
      okAsync({ threads: [thread('t1'), thread('t2')], total: 3 }),
    );
    await loadProjectThreads('p1');
    mockApi.listThreads.mockReturnValueOnce(
      okAsync({ threads: [thread('t2'), thread('t3')], total: 3 }),
    );
    await loadMoreProjectThreads('p1');

    expect(mockApi.listThreads).toHaveBeenLastCalledWith('p1', false, 50, 2);
    expect(members('project:p1')).toEqual(['t1', 't2', 't3']);
    expect(data().meta.getState().totals['project:p1']).toBe(3);
  });

  /** Threads `t<from>` … `t<from + count - 1>`, in that order. */
  const threadRange = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => thread(`t${from + i}`));

  /** List `count` rows of p1 through page 1 plus load-more pages of 50. */
  async function listRows(count: number) {
    mockApi.listThreads.mockReturnValueOnce(
      okAsync({ threads: threadRange(0, Math.min(50, count)), total: count }),
    );
    await loadProjectThreads('p1');
    for (let offset = 50; offset < count; offset += 50) {
      mockApi.listThreads.mockReturnValueOnce(
        okAsync({ threads: threadRange(offset, Math.min(50, count - offset)), total: count }),
      );
      await loadMoreProjectThreads('p1');
    }
    expect(members('project:p1')).toHaveLength(count);
  }

  test('a refresh refetches every loaded page instead of collapsing to page 1 (#186)', async () => {
    await listRows(70);

    // t60 got activity and moves to the top; the rest shift down by one.
    mockApi.listThreads.mockReturnValueOnce(
      okAsync({
        threads: [thread('t60'), ...threadRange(0, 60), ...threadRange(61, 9)],
        total: 70,
      }),
    );
    await loadProjectThreads('p1');

    expect(mockApi.listThreads).toHaveBeenLastCalledWith('p1', false, 100);
    const listed = members('project:p1') ?? [];
    expect(listed).toHaveLength(70);
    expect(listed.slice(0, 2)).toEqual(['t60', 't0']);
    expect(listed.at(-1)).toBe('t69');
  });

  test('a refresh drops a row deleted elsewhere from a multi-page list', async () => {
    await listRows(70);
    mockApi.listThreads.mockReturnValueOnce(
      okAsync({ threads: [...threadRange(0, 55), ...threadRange(56, 14)], total: 69 }),
    );
    await loadProjectThreads('p1');

    const listed = members('project:p1') ?? [];
    expect(listed).not.toContain('t55');
    // Listed rows match the total, so "has more" and the next offset stay right.
    expect(listed).toHaveLength(69);
    expect(data().meta.getState().totals['project:p1']).toBe(69);
  });

  test('a refresh with only page 1 loaded drops rows it no longer lists', async () => {
    mockApi.listThreads.mockReturnValueOnce(
      okAsync({ threads: [thread('t1'), thread('t2')], total: 2 }),
    );
    await loadProjectThreads('p1');
    mockApi.listThreads.mockReturnValueOnce(okAsync({ threads: [thread('t1')], total: 1 }));
    await loadProjectThreads('p1');
    expect(mockApi.listThreads).toHaveBeenLastCalledWith('p1', false, 50);
    expect(members('project:p1')).toEqual(['t1']);
  });

  test('kept archived rows do not widen the refreshed range', async () => {
    mockApi.listThreads.mockReturnValueOnce(
      okAsync({
        threads: [...threadRange(0, 50), thread('a1', { archived: true })],
        total: 51,
      }),
    );
    await loadProjectThreads('p1', true);
    mockApi.listThreads.mockReturnValueOnce(okAsync({ threads: threadRange(1, 49), total: 49 }));
    await loadProjectThreads('p1');

    expect(mockApi.listThreads).toHaveBeenLastCalledWith('p1', false, 50);
    expect(members('project:p1')).not.toContain('t0');
    expect(members('project:p1')).toContain('a1');
  });

  test('rows past the largest refresh the server allows are kept', async () => {
    await listRows(250);
    mockApi.listThreads.mockReturnValueOnce(okAsync({ threads: threadRange(0, 200), total: 250 }));
    await loadProjectThreads('p1');

    expect(mockApi.listThreads).toHaveBeenLastCalledWith('p1', false, 200);
    expect(members('project:p1')).toHaveLength(250);
    expect(members('project:p1')?.at(-1)).toBe('t249');
  });

  test('archived rows survive a non-archived reload that omits them', async () => {
    mockApi.listThreads.mockReturnValueOnce(
      okAsync({ threads: [thread('t1'), thread('a1', { archived: true })], total: 2 }),
    );
    await loadProjectThreads('p1', true);
    mockApi.listThreads.mockReturnValueOnce(okAsync({ threads: [thread('t1')], total: 1 }));
    await loadProjectThreads('p1');
    expect(members('project:p1')).toEqual(['t1', 'a1']);
  });

  test('the same thread from two lists is one row (spec: loading the same entity twice)', async () => {
    mockApi.listThreads.mockReturnValue(okAsync({ threads: [thread('t1')], total: 1 }));
    mockApi.listSharedWithMe.mockReturnValue(
      okAsync({ threads: [thread('t1', { title: 'renamed' })] }),
    );
    await loadProjectThreads('p1');
    await loadSharedThreads();
    expect(data().collection.size).toBe(1);
    expect(visible('t1')?.title).toBe('renamed');
  });

  test('spec: a list row and a detail response merge into one row', async () => {
    mockApi.listThreads.mockReturnValue(okAsync({ threads: [thread('t1')], total: 1 }));
    await loadProjectThreads('p1');
    applyThreadDetail('t1', { status: 'running', branch: 'feat/x' }, beginThreadRequest());

    expect(data().collection.size).toBe(1);
    expect(visible('t1')).toMatchObject({
      id: 't1',
      status: 'running',
      branch: 'feat/x',
      title: 't1',
    });
    // A detail response alone never adds a thread to a list.
    applyThreadDetail('other', { status: 'running' }, beginThreadRequest());
    expect(visible('other')).toBeUndefined();
  });

  test('addScratchThread prepends once', () => {
    addScratchThread(thread('s1', { projectId: '', isScratch: true }));
    addScratchThread(thread('s2', { projectId: '', isScratch: true }));
    addScratchThread(thread('s2', { projectId: '', isScratch: true }));
    expect(members('scratch')).toEqual(['s2', 's1']);
    expect(data().meta.getState().totals.scratch).toBe(2);
  });

  test('removeThreadLocally drops the row and its memberships', async () => {
    mockApi.listThreads.mockReturnValue(
      okAsync({ threads: [thread('t1'), thread('t2')], total: 2 }),
    );
    await loadProjectThreads('p1');
    removeThreadLocally('t1');
    expect(visible('t1')).toBeUndefined();
    expect(members('project:p1')).toEqual(['t2']);
    expect(data().meta.getState().totals['project:p1']).toBe(1);
  });

  test('a response from a previous session never lands in the new one', async () => {
    const call = gatedCall<{ threads: Thread[]; total: number }>();
    mockApi.listThreads.mockReturnValue(call.result);
    const pending = loadProjectThreads('p1');

    setDataLayerSession({ userId: 'someone-else' });
    call.release({ threads: [thread('secret')], total: 1 });
    await pending;

    expect(getThreadsData(getDataLayer()).collection.get('secret')).toBeUndefined();
    expect(getThreadsData(getDataLayer()).meta.getState().members['project:p1']).toBeUndefined();
  });
});

describe('optimistic writes', () => {
  beforeEach(async () => {
    mockApi.listThreads.mockReturnValue(
      okAsync({ threads: [thread('t1'), thread('t2')], total: 2 }),
    );
    await loadProjectThreads('p1');
  });

  test('apply in the same tick, before the server responds', () => {
    const call = gatedCall<unknown>();
    mockApi.updateThreadStage.mockReturnValue(call.result);
    void moveThreadStage('t1', 'review');
    expect(visible('t1')?.stage).toBe('review');
    call.release(undefined);
  });

  test('spec: stale list response during an archive', async () => {
    // A list request starts BEFORE the archive…
    const list = gatedCall<{ threads: Thread[]; total: number }>();
    mockApi.listThreads.mockReturnValue(list.result);
    const refresh = loadProjectThreads('p1');

    mockApi.archiveThread.mockReturnValue(okAsync(undefined));
    await archiveThread('t1');
    expect(visible('t1')?.archived).toBe(true);

    // …and resolves AFTER the archive was confirmed, with the pre-write row.
    list.release({ threads: [thread('t1', { archived: false }), thread('t2')], total: 2 });
    await refresh;
    expect(visible('t1')?.archived).toBe(true);
  });

  test('spec: slow confirmation keeps the move through unrelated refreshes', async () => {
    const confirm = gatedCall<unknown>();
    mockApi.updateThreadStage.mockReturnValue(confirm.result);
    const move = moveThreadStage('t1', 'review');

    // Several refreshes complete while the stage request is still pending.
    for (let i = 0; i < 3; i++) {
      mockApi.listThreads.mockReturnValueOnce(
        okAsync({ threads: [thread('t1', { stage: 'backlog' }), thread('t2')], total: 2 }),
      );
      await loadProjectThreads('p1');
      expect(visible('t1')?.stage).toBe('review');
    }

    confirm.release(undefined);
    await move;
    expect(visible('t1')?.stage).toBe('review');

    // A response that started after confirmation is authoritative again.
    mockApi.listThreads.mockReturnValueOnce(
      okAsync({ threads: [thread('t1', { stage: 'done' }), thread('t2')], total: 2 }),
    );
    await loadProjectThreads('p1');
    expect(visible('t1')?.stage).toBe('done');
  });

  test('spec: confirmed state converges with no flicker', async () => {
    const seen: (boolean | undefined)[] = [];
    const sub = data().collection.subscribeChanges((changes) => {
      for (const change of changes) if (change.key === 't1') seen.push(visible('t1')?.archived);
    });
    mockApi.archiveThread.mockReturnValue(okAsync(undefined));
    await archiveThread('t1');
    sub.unsubscribe();

    // Optimistic apply, then nothing but the same value: never back to false.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((archived) => archived === true)).toBe(true);
    expect(visible('t1')?.archived).toBe(true);
    expect(data().getSynced('t1')?.archived).toBe(true);
  });

  test('rows read through readThread carry no virtual props and keep identity', async () => {
    const row = visible('t1')!;
    expect(Object.keys(row).some((key) => key.startsWith('$'))).toBe(false);
    expect(visible('t1')).toBe(row);
    expect(row).toBe(data().getSynced('t1'));
  });

  test('other rows keep receiving synced updates while a write is pending', () => {
    const call = gatedCall<unknown>();
    mockApi.archiveThread.mockReturnValue(call.result);
    void archiveThread('t1');

    data().patchSynced('t2', (t) => ({ ...t, status: 'running' }));
    expect(visible('t2')?.status).toBe('running');
    call.release(undefined);
  });

  test('spec: archive rejected rolls back and shows an error', async () => {
    mockApi.archiveThread.mockReturnValue(errAsync({ type: 'INTERNAL', message: 'boom' }));
    const result = await archiveThread('t1');

    expect(result.isErr()).toBe(true);
    expect(visible('t1')?.archived).toBeFalsy();
    expect(emitted).toEqual([expect.objectContaining({ type: 'toast', level: 'error' })]);
  });

  test('spec: concurrent server change during a failed write', async () => {
    const call = deferred<void>();
    mockApi.updateThreadStage.mockReturnValue(
      new ResultAsync(
        call.promise.then(() => errAsync({ type: 'INTERNAL', message: 'boom' } as const)),
      ),
    );
    const move = moveThreadStage('t1', 'review');

    // A realtime status change lands while the move is pending.
    data().patchSynced('t1', (t) => ({ ...t, status: 'running' }));
    call.resolve();
    await move;

    expect(visible('t1')?.stage).toBe('backlog');
    expect(visible('t1')?.status).toBe('running');
  });

  test('unarchive keeps the confirmed first step when the second fails', async () => {
    mockApi.archiveThread.mockReturnValue(okAsync(undefined));
    await archiveThread('t1');

    mockApi.updateThreadStage.mockReturnValue(errAsync({ type: 'INTERNAL', message: 'boom' }));
    const result = await unarchiveThread('t1', 'review');

    expect(result.isErr()).toBe(true);
    expect(visible('t1')?.archived).toBe(false);
    expect(visible('t1')?.stage).toBe('backlog');
  });

  test('a write to an unknown thread still calls the server', async () => {
    mockApi.archiveThread.mockReturnValue(okAsync(undefined));
    const result = await archiveThread('missing');
    expect(result.isOk()).toBe(true);
    expect(mockApi.archiveThread).toHaveBeenCalledWith('missing', true);
  });
});

describe('batchWrites', () => {
  beforeEach(async () => {
    mockApi.listThreads.mockReturnValue(
      okAsync({ threads: [thread('t1'), thread('t2')], total: 2 }),
    );
    await loadProjectThreads('p1');
  });

  test('many synced writes in one scope reach subscribers as one commit', () => {
    const commits: number[] = [];
    const sub = data().collection.subscribeChanges((changes) => commits.push(changes.length), {
      includeInitialState: true,
    });
    commits.length = 0;

    data().batchWrites(() => {
      data().patchSynced('t1', (t) => ({ ...t, status: 'running' }));
      data().patchSynced('t2', (t) => ({ ...t, status: 'running' }));
      data().patchSynced('t1', (t) => ({ ...t, lastAssistantMessage: 'hi' }));
      // Reads of synced rows see held writes at once…
      expect(data().getSynced('t1')?.status).toBe('running');
      // …the collection and its subscribers see them when the scope ends.
      expect(data().collection.get('t1')?.status).toBe('idle');
    });
    sub.unsubscribe();

    expect(commits).toEqual([2]);
    expect(visible('t1')).toMatchObject({ status: 'running', lastAssistantMessage: 'hi' });
    expect(visible('t2')?.status).toBe('running');
  });

  test('nested scopes commit once at the outermost end', () => {
    const commits: number[] = [];
    const sub = data().collection.subscribeChanges((changes) => commits.push(changes.length), {
      includeInitialState: true,
    });
    commits.length = 0;
    data().batchWrites(() => {
      data().patchSynced('t1', (t) => ({ ...t, status: 'running' }));
      data().batchWrites(() => data().patchSynced('t2', (t) => ({ ...t, status: 'running' })));
      expect(commits).toEqual([]);
    });
    sub.unsubscribe();
    expect(commits).toEqual([2]);
  });

  test('a row inserted and removed inside the scope is never visible', () => {
    const seen: string[] = [];
    const sub = data().collection.subscribeChanges(
      (changes) => seen.push(...changes.map((c) => `${c.type}:${String(c.key)}`)),
      { includeInitialState: true },
    );
    seen.length = 0;
    data().batchWrites(() => {
      data().upsertFresh([thread('tmp')]);
      data().removeRows(['tmp']);
      data().removeRows(['t2']);
    });
    sub.unsubscribe();
    expect(seen).toEqual(['delete:t2']);
    expect(visible('tmp')).toBeUndefined();
  });

  test('an exception still commits what was written before it', () => {
    expect(() =>
      data().batchWrites(() => {
        data().patchSynced('t1', (t) => ({ ...t, status: 'running' }));
        throw new Error('handler failed');
      }),
    ).toThrow('handler failed');
    expect(visible('t1')?.status).toBe('running');
  });
});
