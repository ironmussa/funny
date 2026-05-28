/**
 * Regression tests for `lib/thread-selectors`.
 *
 * The selectors must return STABLE references across calls when the
 * underlying data is unchanged — otherwise `useSyncExternalStore`
 * fires the "getSnapshot should be cached" warning and infinite-loops
 * the component tree (the bug we hit on the first runtime of the
 * unified-store refactor).
 */

import type { Thread } from '@funny/shared';
import { describe, test, expect } from 'vitest';

import {
  selectScratchThreads,
  selectThreadById,
  selectThreadsByProject,
  selectThreadsForProject,
} from '@/lib/thread-selectors';
import type { ThreadState } from '@/stores/thread-store';

function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: 'p1',
    title: id,
    status: 'idle' as any,
    cost: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Thread;
}

function makeState(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    threadsById: {},
    threadIdsByProject: {},
    scratchThreadIds: [],
    threadTotalByProject: {},
    scratchThreadTotal: 0,
    selectedThreadId: null,
    threadDataById: {},
    activeThread: null,
    setupProgressByThread: {},
    contextUsageByThread: {},
    queuedCountByThread: {},
    ...overrides,
  } as ThreadState;
}

describe('selectThreadsForProject — stable references', () => {
  test('returns the same array reference when called twice with the same state', () => {
    const t1 = makeThread('t1');
    const t2 = makeThread('t2');
    const state = makeState({
      threadsById: { t1, t2 },
      threadIdsByProject: { p1: ['t1', 't2'] },
    });

    const a = selectThreadsForProject(state, 'p1');
    const b = selectThreadsForProject(state, 'p1');
    expect(a).toBe(b);
  });

  test('returns the same array reference when an unrelated project changes', () => {
    const t1 = makeThread('t1', { projectId: 'p1' });
    const t2 = makeThread('t2', { projectId: 'p2' });
    const idsP1 = ['t1'];

    const before = makeState({
      threadsById: { t1, t2 },
      threadIdsByProject: { p1: idsP1, p2: ['t2'] },
    });
    const a = selectThreadsForProject(before, 'p1');

    // p2's thread row changes — p1's slice should NOT be invalidated.
    const t2Updated = { ...t2, status: 'completed' as any };
    const after = makeState({
      threadsById: { t1, t2: t2Updated },
      threadIdsByProject: { p1: idsP1, p2: ['t2'] },
    });
    const b = selectThreadsForProject(after, 'p1');

    expect(a).toBe(b);
  });

  test('returns a new array when a thread inside the project changes', () => {
    const t1 = makeThread('t1');
    const ids = ['t1'];
    const before = makeState({
      threadsById: { t1 },
      threadIdsByProject: { p1: ids },
    });
    const a = selectThreadsForProject(before, 'p1');

    const t1Updated = { ...t1, status: 'completed' as any };
    const after = makeState({
      threadsById: { t1: t1Updated },
      threadIdsByProject: { p1: ids },
    });
    const b = selectThreadsForProject(after, 'p1');

    expect(a).not.toBe(b);
    expect(b[0]).toBe(t1Updated);
  });

  test('returns an empty array sentinel when the project has no threads', () => {
    const state = makeState();
    const a = selectThreadsForProject(state, 'unknown');
    const b = selectThreadsForProject(state, 'unknown');
    expect(a).toEqual([]);
    expect(a).toBe(b);
  });
});

describe('selectScratchThreads — stable references', () => {
  test('returns the same array reference when called twice with the same state', () => {
    const s1 = makeThread('s1', { projectId: '', isScratch: true });
    const state = makeState({
      threadsById: { s1 },
      scratchThreadIds: ['s1'],
    });

    expect(selectScratchThreads(state)).toBe(selectScratchThreads(state));
  });
});

describe('selectThreadsByProject — shallow-stable Record', () => {
  test('per-project arrays keep the same reference when the unrelated project changes', () => {
    const t1 = makeThread('t1', { projectId: 'p1' });
    const t2 = makeThread('t2', { projectId: 'p2' });
    const idsP1 = ['t1'];
    const idsP2 = ['t2'];

    const before = makeState({
      threadsById: { t1, t2 },
      threadIdsByProject: { p1: idsP1, p2: idsP2 },
    });
    const a = selectThreadsByProject(before);

    // Patch t2 — p1's slice must keep the same reference.
    const after = makeState({
      threadsById: { t1, t2: { ...t2, status: 'completed' as any } },
      threadIdsByProject: { p1: idsP1, p2: idsP2 },
    });
    const b = selectThreadsByProject(after);

    expect(a.p1).toBe(b.p1);
    expect(a.p2).not.toBe(b.p2);
  });
});

describe('selectThreadById', () => {
  test('returns the same Thread reference each call', () => {
    const t1 = makeThread('t1');
    const state = makeState({ threadsById: { t1 } });
    expect(selectThreadById(state, 't1')).toBe(t1);
  });

  test('returns undefined for unknown id', () => {
    const state = makeState();
    expect(selectThreadById(state, 'missing')).toBeUndefined();
  });
});

describe('selectThreadsForProject — missing thread rows', () => {
  test('skips ids that are not present in threadsById', () => {
    const t1 = makeThread('t1');
    const state = makeState({
      threadsById: { t1 },
      threadIdsByProject: { p1: ['t1', 'ghost'] },
    });
    expect(selectThreadsForProject(state, 'p1')).toEqual([t1]);
  });
});

describe('selectThreadsByProject — empty buckets', () => {
  test('returns the empty sentinel when no projects are loaded', () => {
    const state = makeState();
    const a = selectThreadsByProject(state);
    const b = selectThreadsByProject(state);
    expect(a).toEqual({});
    expect(a).toBe(b);
  });
});
