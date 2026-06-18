import type { Thread } from '@funny/shared';
import { afterEach, describe, test, expect } from 'vitest';

import {
  replaceProjectThreads,
  appendProjectThreads,
  clearProjectBucket,
  replaceScratchThreads,
  prependScratchThread,
  removeThread,
  patchThread,
  applyThreadDataPatch,
  setThreadData,
  clearThreadData,
  findProjectForThread,
} from '@/stores/thread-mutations';
import {
  guardOptimisticBoardWrite,
  _resetOptimisticBoardWrites,
} from '@/stores/thread-optimistic-guard';
import type { ThreadState } from '@/stores/thread-state';
import type { ThreadWithMessages } from '@/stores/thread-types';

import { seedThreads } from '../helpers/seed-thread-state';

afterEach(() => _resetOptimisticBoardWrites());

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
    threadsById: {},
    threadIdsByProject: {},
    scratchThreadIds: [],
    sharedThreadIds: [],
    threadTotalByProject: {},
    scratchThreadTotal: 0,
    sharedThreadTotal: 0,
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

describe('thread-mutations — project buckets', () => {
  test('replaceProjectThreads upserts rows and replaces id order', () => {
    const state = emptyState({
      ...seedThreads({ p1: [makeThread('old')] }),
      threadTotalByProject: { p1: 1 },
    });
    const incoming = [makeThread('t2'), makeThread('t3')];

    const patch = replaceProjectThreads(state, 'p1', incoming, 99);

    expect(patch.threadIdsByProject!.p1).toEqual(['t2', 't3']);
    expect(patch.threadTotalByProject!.p1).toBe(99);
    expect(patch.threadsById!.t2.title).toBe('Thread t2');
    expect(patch.threadsById!.t3).toBeDefined();
    // Old row remains in map until explicitly removed — replace only swaps order.
    expect(patch.threadsById!.old).toBeDefined();
  });

  test('replaceProjectThreads keeps resident archived threads omitted by the page', () => {
    const state = emptyState({
      ...seedThreads({
        p1: [makeThread('active'), makeThread('arch', { archived: true })],
      }),
      threadTotalByProject: { p1: 2 },
    });
    // A non-archived reload returns only the active thread.
    const patch = replaceProjectThreads(state, 'p1', [makeThread('active')], 1);

    // The archived card survives the refresh and is kept at the tail.
    expect(patch.threadIdsByProject!.p1).toEqual(['active', 'arch']);
    expect(patch.threadsById!.arch.archived).toBe(true);
  });

  test('replaceProjectThreads does not duplicate an archived thread present in the page', () => {
    const state = emptyState({
      ...seedThreads({ p1: [makeThread('arch', { archived: true })] }),
      threadTotalByProject: { p1: 1 },
    });
    // An includeArchived reload returns the archived thread in the page itself.
    const patch = replaceProjectThreads(state, 'p1', [makeThread('arch', { archived: true })], 1);

    expect(patch.threadIdsByProject!.p1).toEqual(['arch']);
  });

  test('replaceProjectThreads does not revert an optimistically archived card from a stale page', () => {
    const state = emptyState({
      ...seedThreads({ p1: [makeThread('t1', { archived: true, stage: 'in_progress' })] }),
      threadTotalByProject: { p1: 1 },
    });
    // The user just archived t1 (optimistic) — guard the write.
    guardOptimisticBoardWrite('t1', { archived: true });
    // A list GET that started before the archive committed returns t1 as live.
    const stalePage = [makeThread('t1', { archived: false, stage: 'in_progress' })];

    const patch = replaceProjectThreads(state, 'p1', stalePage, 1);

    // The card stays archived instead of bouncing back to its old column.
    expect(patch.threadsById!.t1.archived).toBe(true);
    expect(patch.threadIdsByProject!.p1).toEqual(['t1']);
  });

  test('replaceProjectThreads does not revive a locally completed thread from a stale running page', () => {
    const completed = makeThread('t1', {
      status: 'completed',
      completedAt: '2026-01-01T00:01:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    });
    const state = emptyState({
      ...seedThreads({ p1: [completed] }),
      threadTotalByProject: { p1: 1 },
    });

    const stalePage = [
      makeThread('t1', {
        status: 'running',
        completedAt: undefined,
        updatedAt: '2026-01-01T00:00:59.000Z',
      }),
    ];

    const patch = replaceProjectThreads(state, 'p1', stalePage, 1);

    expect(patch.threadsById!.t1.status).toBe('completed');
    expect(patch.threadsById!.t1.completedAt).toBe('2026-01-01T00:01:00.000Z');
  });

  test('replaceProjectThreads accepts a newer running row after a completed thread', () => {
    const completed = makeThread('t1', {
      status: 'completed',
      completedAt: '2026-01-01T00:01:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    });
    const state = emptyState({
      ...seedThreads({ p1: [completed] }),
      threadTotalByProject: { p1: 1 },
    });

    const followUpPage = [
      makeThread('t1', {
        status: 'running',
        completedAt: undefined,
        updatedAt: '2026-01-01T00:02:00.000Z',
      }),
    ];

    const patch = replaceProjectThreads(state, 'p1', followUpPage, 1);

    expect(patch.threadsById!.t1.status).toBe('running');
  });

  test('appendProjectThreads skips duplicate ids and updates total only when empty', () => {
    const t1 = makeThread('t1');
    const state = emptyState({
      ...seedThreads({ p1: [t1] }),
      threadTotalByProject: { p1: 1 },
    });

    const emptyAppend = appendProjectThreads(state, 'p1', [], 5);
    expect(emptyAppend.threadIdsByProject).toBeUndefined();
    expect(emptyAppend.threadTotalByProject!.p1).toBe(5);

    const dupAppend = appendProjectThreads(state, 'p1', [t1, makeThread('t2')], 2);
    expect(dupAppend.threadIdsByProject!.p1).toEqual(['t1', 't2']);
    expect(dupAppend.threadsById!.t2).toBeDefined();
  });

  test('clearProjectBucket removes all project threads from the index', () => {
    const state = emptyState({
      ...seedThreads({ p1: [makeThread('t1'), makeThread('t2')] }),
      threadTotalByProject: { p1: 2 },
    });

    const patch = clearProjectBucket(state, 'p1');

    expect(patch.threadIdsByProject!.p1).toBeUndefined();
    expect(patch.threadTotalByProject!.p1).toBeUndefined();
    expect(patch.threadsById!.t1).toBeUndefined();
    expect(patch.threadsById!.t2).toBeUndefined();
  });

  test('clearProjectBucket is a no-op for unknown project', () => {
    expect(clearProjectBucket(emptyState(), 'missing')).toEqual({});
  });
});

describe('thread-mutations — scratch bucket', () => {
  test('replaceScratchThreads sets scratch order and total', () => {
    const threads = [
      makeThread('s1', { projectId: '', isScratch: true }),
      makeThread('s2', { projectId: '', isScratch: true }),
    ];
    const patch = replaceScratchThreads(emptyState(), threads, 10);

    expect(patch.scratchThreadIds).toEqual(['s1', 's2']);
    expect(patch.scratchThreadTotal).toBe(10);
    expect(patch.threadsById!.s1.isScratch).toBe(true);
  });

  test('prependScratchThread adds to front and increments total', () => {
    const existing = makeThread('s-old', { projectId: '', isScratch: true });
    const state = emptyState({
      ...seedThreads({}),
      scratchThreadIds: ['s-old'],
      scratchThreadTotal: 1,
      threadsById: { 's-old': existing },
    });
    const fresh = makeThread('s-new', { projectId: '', isScratch: true });

    const patch = prependScratchThread(state, fresh);

    expect(patch.scratchThreadIds).toEqual(['s-new', 's-old']);
    expect(patch.scratchThreadTotal).toBe(2);
  });

  test('prependScratchThread de-dupes WS-vs-API race', () => {
    const scratch = makeThread('s1', { projectId: '', isScratch: true });
    const state = emptyState({
      scratchThreadIds: ['s1'],
      scratchThreadTotal: 1,
      threadsById: { s1: scratch },
    });

    expect(prependScratchThread(state, scratch)).toEqual({});
  });
});

describe('thread-mutations — cross-bucket remove', () => {
  test('removeThread drops scratch thread and decrements scratch total', () => {
    const scratch = makeThread('s1', { projectId: '', isScratch: true });
    const state = emptyState({
      scratchThreadIds: ['s1'],
      scratchThreadTotal: 1,
      threadsById: { s1: scratch },
    });

    const patch = removeThread(state, 's1');

    expect(patch.scratchThreadIds).toEqual([]);
    expect(patch.scratchThreadTotal).toBe(0);
    expect(patch.threadsById!.s1).toBeUndefined();
  });

  test('removeThread drops project thread and decrements project total', () => {
    const state = emptyState({
      ...seedThreads({ p1: [makeThread('t1')] }),
      threadTotalByProject: { p1: 3 },
    });

    const patch = removeThread(state, 't1');

    expect(patch.threadIdsByProject!.p1).toEqual([]);
    expect(patch.threadTotalByProject!.p1).toBe(2);
    expect(patch.threadsById!.t1).toBeUndefined();
  });
});

describe('thread-mutations — patchThread', () => {
  test('returns empty patch when thread is unknown', () => {
    expect(patchThread(emptyState(), 'missing', (t) => ({ ...t, title: 'x' }))).toEqual({});
  });

  test('returns empty patch when updater returns same reference', () => {
    const t1 = makeThread('t1');
    const state = emptyState({ ...seedThreads({ p1: [t1] }) });
    expect(patchThread(state, 't1', (t) => t)).toEqual({});
  });

  test('mirrors onto activeThread when patching the selected thread', () => {
    const t1 = makeThread('t1', { status: 'idle' });
    const active = makeThreadWithMessages('t1');
    active.status = 'idle';
    const state = emptyState({
      ...seedThreads({ p1: [t1] }),
      selectedThreadId: 't1',
      activeThread: active,
    });

    const patch = patchThread(state, 't1', (t) => ({ ...t, status: 'running' }));

    expect(patch.threadsById!.t1.status).toBe('running');
    expect(patch.activeThread!.status).toBe('running');
  });
});

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

describe('thread-mutations — findProjectForThread', () => {
  test('returns project id for indexed thread', () => {
    const state = emptyState({ ...seedThreads({ p1: [makeThread('t1')] }) });
    expect(findProjectForThread(state, 't1')).toBe('p1');
  });

  test('returns null for scratch or unknown threads', () => {
    const state = emptyState({
      scratchThreadIds: ['s1'],
      threadsById: { s1: makeThread('s1', { projectId: '', isScratch: true }) },
    });
    expect(findProjectForThread(state, 's1')).toBeNull();
    expect(findProjectForThread(state, 'missing')).toBeNull();
  });
});
