import type { Thread } from '@funny/shared';
import { beforeEach, describe, test, expect } from 'vitest';

import {
  guardOptimisticBoardWrite,
  reconcileBoardWrite,
  clearOptimisticBoardWrite,
  _resetOptimisticBoardWrites,
} from '@/stores/thread-optimistic-guard';

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    projectId: 'p1',
    title: 'thread',
    mode: 'local',
    status: 'completed',
    stage: 'in_progress',
    archived: false,
    cost: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Thread;
}

describe('thread-optimistic-guard', () => {
  beforeEach(() => _resetOptimisticBoardWrites());

  test('reconcile is a pass-through (same ref) when no guard is active', () => {
    const t = makeThread();
    expect(reconcileBoardWrite(t)).toBe(t);
  });

  test('keeps the optimistic archived flag over a stale server snapshot', () => {
    guardOptimisticBoardWrite('t1', { archived: true });
    // Stale page still reports the card as live in its old column.
    const stale = makeThread({ archived: false, stage: 'in_progress' });

    const reconciled = reconcileBoardWrite(stale);

    expect(reconciled.archived).toBe(true);
    expect(reconciled).not.toBe(stale);
  });

  test('keeps the optimistic stage over a stale server snapshot', () => {
    guardOptimisticBoardWrite('t1', { stage: 'backlog' });
    const stale = makeThread({ stage: 'review' });

    expect(reconcileBoardWrite(stale).stage).toBe('backlog');
  });

  test('clears the guard once the server snapshot already reflects the write', () => {
    guardOptimisticBoardWrite('t1', { archived: true });
    const fresh = makeThread({ archived: true });

    // First reconcile sees a match → returns server copy and drops the guard.
    expect(reconcileBoardWrite(fresh)).toBe(fresh);

    // A later stale page must no longer be overridden.
    const stale = makeThread({ archived: false });
    expect(reconcileBoardWrite(stale)).toBe(stale);
  });

  test('clearOptimisticBoardWrite removes an active guard', () => {
    guardOptimisticBoardWrite('t1', { archived: true });
    clearOptimisticBoardWrite('t1');
    const stale = makeThread({ archived: false });
    expect(reconcileBoardWrite(stale)).toBe(stale);
  });
});
