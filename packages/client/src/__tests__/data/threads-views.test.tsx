import type { Thread, ThreadStage } from '@funny/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { okAsync, ResultAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { moveThreadStage, archiveThread } from '@/data/threads/actions';
import {
  useLoadedThreads,
  useScratchThreads,
  useThreadById,
  useThreadsByProject,
  useThreadsForProject,
} from '@/data/threads/hooks';
import { setSourceMembers } from '@/data/threads/list-meta';
import { addScratchThread, loadProjectThreads } from '@/data/threads/loaders';
import { getThreadsData } from '@/data/threads/store';
import {
  boardThreadIds,
  deriveOrderedThreads,
  groupThreadsByStage,
  selectActivityThreads,
} from '@/data/threads/views';

import { deferred, installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const mockApi = vi.hoisted(() => ({
  listThreads: vi.fn(),
  archiveThread: vi.fn(),
  updateThreadStage: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: mockApi }));
vi.mock('@/platform/client-composition', () => ({
  clientComposition: { platform: { effects: { emit: vi.fn() } } },
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

function columnsContaining(columns: Record<ThreadStage, Thread[]>, id: string): ThreadStage[] {
  return (Object.keys(columns) as ThreadStage[]).filter((stage) =>
    columns[stage].some((t) => t.id === id),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('groupThreadsByStage', () => {
  test('archived wins over stage; missing stage is backlog; columns use list order', () => {
    const columns = groupThreadsByStage([
      thread('old', { stage: 'review', createdAt: '2026-01-01T00:00:00.000Z' }),
      thread('new', { stage: 'review', createdAt: '2026-02-01T00:00:00.000Z' }),
      thread('pinned', { stage: 'review', pinned: true, createdAt: '2025-01-01T00:00:00.000Z' }),
      thread('arch', { stage: 'review', archived: true }),
      thread('none', { stage: undefined as unknown as ThreadStage }),
    ]);
    expect(columns.review.map((t) => t.id)).toEqual(['pinned', 'new', 'old']);
    expect(columns.archived.map((t) => t.id)).toEqual(['arch']);
    expect(columns.backlog.map((t) => t.id)).toEqual(['none']);
  });

  test('boardThreadIds: one project, or all projects plus scratch without shared', () => {
    const members = {
      'project:p1': ['a', 'b'],
      'project:p2': ['c'],
      scratch: ['s'],
      shared: ['x'],
    };
    expect(boardThreadIds(members, 'p1')).toEqual(['a', 'b']);
    expect(boardThreadIds(members, null)).toEqual(['a', 'b', 'c', 's']);
    expect(boardThreadIds(members, 'missing')).toEqual([]);
  });
});

describe('useLoadedThreads', () => {
  beforeEach(async () => {
    mockApi.listThreads.mockReturnValue(
      okAsync({ threads: [thread('t1'), thread('t2', { stage: 'review' })], total: 2 }),
    );
    await loadProjectThreads('p1');
  });

  test('returns loaded rows and follows new list members', async () => {
    const { result } = renderHook(() => useLoadedThreads(null));
    await waitFor(() => expect(result.current.map((t) => t.id)).toEqual(['t1', 't2']));

    act(() => addScratchThread(thread('s1', { projectId: '', isScratch: true })));
    await waitFor(() => expect(result.current.map((t) => t.id)).toEqual(['t1', 't2', 's1']));

    const filtered = renderHook(() => useLoadedThreads('p1'));
    await waitFor(() => expect(filtered.result.current.map((t) => t.id)).toEqual(['t1', 't2']));
  });

  test('a drag moves a card to exactly one column, optimistically', async () => {
    const confirm = deferred<unknown>();
    mockApi.updateThreadStage.mockReturnValue(ResultAsync.fromSafePromise(confirm.promise));
    const { result } = renderHook(() => groupThreadsByStage(useLoadedThreads('p1')));
    await waitFor(() => expect(columnsContaining(result.current, 't1')).toEqual(['backlog']));

    let move!: ReturnType<typeof moveThreadStage>;
    act(() => {
      move = moveThreadStage('t1', 'in_progress');
    });
    await waitFor(() => expect(columnsContaining(result.current, 't1')).toEqual(['in_progress']));

    confirm.resolve(undefined);
    await act(async () => {
      await move;
    });
    expect(columnsContaining(result.current, 't1')).toEqual(['in_progress']);
  });

  test('archiving moves the card to the archived column only', async () => {
    mockApi.archiveThread.mockReturnValue(okAsync(undefined));
    const { result } = renderHook(() => groupThreadsByStage(useLoadedThreads('p1')));
    await waitFor(() => expect(columnsContaining(result.current, 't2')).toEqual(['review']));

    await act(async () => {
      await archiveThread('t2');
    });
    expect(columnsContaining(result.current, 't2')).toEqual(['archived']);
  });

  test('unchanged rows keep their reference when another row changes', async () => {
    const { result } = renderHook(() => useLoadedThreads('p1'));
    await waitFor(() => expect(result.current).toHaveLength(2));
    const before = result.current.find((t) => t.id === 't1');

    act(() => {
      getThreadsData().patchSynced('t2', (t) => ({ ...t, status: 'running' }));
    });
    await waitFor(() => expect(result.current.find((t) => t.id === 't2')?.status).toBe('running'));
    expect(result.current.find((t) => t.id === 't1')).toBe(before);
    expect(Object.keys(before!).some((key) => key.startsWith('$'))).toBe(false);
  });
});

describe('selector hooks over live queries', () => {
  beforeEach(() => {
    const data = getThreadsData();
    data.upsertFromServer(
      [
        thread('a1'),
        thread('a2'),
        thread('b1', { projectId: 'p2' }),
        thread('s1', { projectId: '', isScratch: true }),
      ],
      data.beginRequest(),
    );
    setSourceMembers(data.meta, 'project:p1', ['a1', 'a2'], 2);
    setSourceMembers(data.meta, 'project:p2', ['b1'], 1);
    setSourceMembers(data.meta, 'scratch', ['s1'], 1);
  });

  test('return rows on the first render, in list order', () => {
    expect(renderHook(() => useThreadById('a2')).result.current?.id).toBe('a2');
    expect(renderHook(() => useThreadById(null)).result.current).toBeUndefined();
    expect(renderHook(() => useThreadsForProject('p1')).result.current.map((t) => t.id)).toEqual([
      'a1',
      'a2',
    ]);
    expect(renderHook(() => useScratchThreads()).result.current.map((t) => t.id)).toEqual(['s1']);
    const byProject = renderHook(() => useThreadsByProject()).result.current;
    expect(
      Object.fromEntries(Object.entries(byProject).map(([k, v]) => [k, v.map((t) => t.id)])),
    ).toEqual({
      p1: ['a1', 'a2'],
      p2: ['b1'],
    });
  });

  test("a change in one project keeps the other project's array and rows stable", async () => {
    const { result } = renderHook(() => useThreadsByProject());
    const before = result.current;

    act(() => {
      getThreadsData().patchSynced('b1', (t) => ({ ...t, status: 'running' }));
    });
    await waitFor(() => expect(result.current.p2[0].status).toBe('running'));

    expect(result.current).not.toBe(before);
    expect(result.current.p1).toBe(before.p1);
    expect(result.current.p1[0]).toBe(before.p1[0]);
  });

  test('useThreadById follows an optimistic write through its confirmation', async () => {
    const { result } = renderHook(() => useThreadById('a1'));
    const gate = deferred<unknown>();
    mockApi.archiveThread.mockReturnValue(ResultAsync.fromSafePromise(gate.promise));
    let pending!: ReturnType<typeof archiveThread>;
    act(() => {
      pending = archiveThread('a1');
    });
    await waitFor(() => expect(result.current?.archived).toBe(true));
    gate.resolve(undefined);
    await act(async () => {
      await pending;
    });
    expect(result.current?.archived).toBe(true);
    expect(Object.keys(result.current!).some((k) => k.startsWith('$'))).toBe(false);
  });
});

describe('selectActivityThreads', () => {
  test('running first, then most recent; idle, archived and done are excluded; top 5', () => {
    const rows = [
      thread('idle', { status: 'idle' }),
      thread('old-running', { status: 'running', createdAt: '2025-01-01T00:00:00.000Z' }),
      thread('done', { status: 'completed', stage: 'done' }),
      thread('arch', { status: 'completed', archived: true }),
      ...Array.from({ length: 6 }, (_, i) =>
        thread(`c${i}`, { status: 'completed', completedAt: `2026-02-0${i + 1}T00:00:00.000Z` }),
      ),
    ];
    const { threads, totalCount } = selectActivityThreads(rows);
    expect(totalCount).toBe(7);
    expect(threads.map((t) => t.id)).toEqual(['old-running', 'c5', 'c4', 'c3', 'c2']);
  });

  test('spec: archiving through any path removes it from Activity and adds it to the archived column', async () => {
    mockApi.listThreads.mockReturnValue(
      okAsync({ threads: [thread('t1', { status: 'completed', stage: 'review' })], total: 1 }),
    );
    await loadProjectThreads('p1');
    const { result } = renderHook(() => {
      const rows = useLoadedThreads(null);
      return { activity: selectActivityThreads(rows).threads, columns: groupThreadsByStage(rows) };
    });
    await waitFor(() => expect(result.current.activity.map((t) => t.id)).toEqual(['t1']));

    // A realtime event (not a user action) archives it.
    act(() => {
      getThreadsData().patchSynced('t1', (t) => ({ ...t, archived: true }));
    });
    await waitFor(() => expect(result.current.activity).toEqual([]));
    expect(columnsContaining(result.current.columns, 't1')).toEqual(['archived']);
  });
});

describe('deriveOrderedThreads (stable list references)', () => {
  const a = thread('a');
  const b = thread('b');
  const byId = { a, b };

  test('same ids and rows → same array; a changed row → new array', () => {
    const ids = ['a', 'b'];
    const first = deriveOrderedThreads(byId, ids);
    expect(deriveOrderedThreads({ ...byId }, ids)).toBe(first);
    expect(deriveOrderedThreads({ ...byId, b: { ...b, title: 'x' } }, ids)).not.toBe(first);
  });

  test('de-dupes ids keeping first occurrence, skips ids without a row, empty sentinel', () => {
    expect(deriveOrderedThreads(byId, ['b', 'a', 'b', 'missing']).map((t) => t.id)).toEqual([
      'b',
      'a',
    ]);
    expect(deriveOrderedThreads(byId, [])).toBe(deriveOrderedThreads(byId, undefined));
  });
});

describe('spec: scratch and project lists are disjoint', () => {
  test('a scratch thread never appears in a project list and vice versa', async () => {
    mockApi.listThreads.mockReturnValue(okAsync({ threads: [thread('p-thread')], total: 1 }));
    await loadProjectThreads('p1');
    act(() => addScratchThread(thread('s-thread', { projectId: '', isScratch: true })));
    // An empty project id is never loaded as a project list (it would list every thread).
    await loadProjectThreads('');

    const byProject = renderHook(() => useThreadsByProject()).result.current;
    const scratch = renderHook(() => useScratchThreads()).result.current;
    const projectIds = Object.values(byProject)
      .flat()
      .map((t) => t.id);

    expect(projectIds).toEqual(['p-thread']);
    expect(scratch.map((t) => t.id)).toEqual(['s-thread']);
    expect(Object.keys(byProject)).toEqual(['p1']);
    expect(mockApi.listThreads).toHaveBeenCalledTimes(1);
  });
});
