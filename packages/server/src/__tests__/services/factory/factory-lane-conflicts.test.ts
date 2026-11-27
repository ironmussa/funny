/**
 * The daily cross-lane conflict check (openspec factory-lanes D7): when it is
 * due, what each lane stores, and how a failure and an old git are handled.
 */

import { describe, expect, test } from 'bun:test';

import { err, ok, okAsync } from 'neverthrow';

import {
  checkLaneConflicts,
  conflictsByLane,
  isLaneConflictCheckDue,
  LANE_CONFLICT_CHECK_INTERVAL_MS,
  LANE_CONFLICT_RETRY_MS,
  type LaneConflictCheckDeps,
} from '../../../services/factory/factory-lane-conflicts.js';
import type {
  FactoryLaneView,
  LaneConflictRecord,
} from '../../../services/factory/factory-lanes.js';
import type { LaneConflictsAnswer } from '../../../services/factory/factory-runner-jobs.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');

function lane(name: string, over: Partial<FactoryLaneView> = {}): FactoryLaneView {
  return {
    id: `lane-${name}`,
    factoryId: 'f1',
    name,
    baseBranch: null,
    finishBranch: null,
    branch: `feature/${name}`,
    state: 'active',
    ciWarning: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    syncState: 'idle',
    syncBaseSha: null,
    syncPrNumber: null,
    syncThreadId: null,
    syncTurnAt: null,
    syncAttempts: 0,
    syncStartedAt: null,
    syncError: null,
    lastSyncedBaseSha: null,
    finishPrNumber: null,
    conflicts: null,
    conflictsCheckedAt: null,
    conflictsNote: null,
    ...over,
  };
}

function harness(lanes: FactoryLaneView[], answer: LaneConflictsAnswer | string) {
  const stored = new Map<string, LaneConflictRecord>();
  const asked: string[][] = [];
  const deps: LaneConflictCheckDeps = {
    lanes: {
      list: () => okAsync(lanes),
      setConflicts: (laneId, record) => {
        stored.set(laneId, record);
        return okAsync(undefined);
      },
    },
    check: async (branches) => {
      asked.push(branches);
      return typeof answer === 'string' ? err(answer) : ok(answer);
    },
    now: () => NOW,
    failedAt: new Map(),
  };
  return { deps, stored, asked };
}

describe('isLaneConflictCheckDue', () => {
  const checked = (ms: number) => new Date(NOW - ms).toISOString();

  test('needs two active lanes', () => {
    expect(isLaneConflictCheckDue([lane('a')], NOW)).toBe(false);
    expect(isLaneConflictCheckDue([lane('a'), lane('b', { state: 'finished' })], NOW)).toBe(false);
    expect(isLaneConflictCheckDue([lane('a'), lane('b')], NOW)).toBe(true);
  });

  test('runs once a day', () => {
    const recent = checked(LANE_CONFLICT_CHECK_INTERVAL_MS - 60_000);
    const old = checked(LANE_CONFLICT_CHECK_INTERVAL_MS);
    expect(
      isLaneConflictCheckDue(
        [lane('a', { conflictsCheckedAt: recent }), lane('b', { conflictsCheckedAt: recent })],
        NOW,
      ),
    ).toBe(false);
    expect(
      isLaneConflictCheckDue(
        [lane('a', { conflictsCheckedAt: recent }), lane('b', { conflictsCheckedAt: old })],
        NOW,
      ),
    ).toBe(true);
    // A lane made since the last check is checked at once.
    expect(
      isLaneConflictCheckDue([lane('a', { conflictsCheckedAt: recent }), lane('b')], NOW),
    ).toBe(true);
  });
});

describe('conflictsByLane', () => {
  test('gives each lane of a conflicting pair the other one, with the paths', () => {
    const byLane = conflictsByLane(
      [lane('a'), lane('b'), lane('c')],
      [{ a: 'feature/a', b: 'feature/b', paths: ['src/router.ts'] }],
    );
    expect(byLane.get('a')).toEqual([{ lane: 'b', paths: ['src/router.ts'] }]);
    expect(byLane.get('b')).toEqual([{ lane: 'a', paths: ['src/router.ts'] }]);
    expect(byLane.get('c')).toEqual([]);
  });
});

describe('checkLaneConflicts', () => {
  test('stores the conflicts of each active lane, and that the others have none', async () => {
    const { deps, stored, asked } = harness(
      [lane('a'), lane('b'), lane('c'), lane('old', { state: 'finished' })],
      {
        kind: 'checked',
        conflicts: [{ a: 'feature/a', b: 'feature/b', paths: ['src/router.ts'] }],
        missing: [],
        fetched: true,
      },
    );

    expect(await checkLaneConflicts(deps, 'f1')).toBe('checked');
    // A finished lane is not compared.
    expect(asked).toEqual([['feature/a', 'feature/b', 'feature/c']]);
    const checkedAt = new Date(NOW).toISOString();
    expect(stored.get('lane-a')).toEqual({
      conflicts: [{ lane: 'b', paths: ['src/router.ts'] }],
      checkedAt,
      note: null,
    });
    expect(stored.get('lane-b')?.conflicts).toEqual([{ lane: 'a', paths: ['src/router.ts'] }]);
    expect(stored.get('lane-c')).toEqual({ conflicts: [], checkedAt, note: null });
    expect(stored.has('lane-old')).toBe(false);
  });

  test('notes a lane whose branch is not on the remote yet', async () => {
    const { deps, stored } = harness([lane('a'), lane('b')], {
      kind: 'checked',
      conflicts: [],
      missing: ['feature/b'],
      fetched: true,
    });
    await checkLaneConflicts(deps, 'f1');
    expect(stored.get('lane-a')?.note).toBeNull();
    expect(stored.get('lane-b')?.note).toContain('not on the remote');
  });

  test('stores an old git as the note and waits a day like a check that ran', async () => {
    const { deps, stored } = harness([lane('a'), lane('b')], {
      kind: 'unavailable',
      reason: 'git 2.38 or later is needed (found 2.34)',
    });
    expect(await checkLaneConflicts(deps, 'f1')).toBe('unavailable');
    expect(stored.get('lane-a')).toEqual({
      conflicts: null,
      checkedAt: new Date(NOW).toISOString(),
      note: 'git 2.38 or later is needed (found 2.34)',
    });
  });

  test('a runner that cannot be reached is retried after an hour, not on every tick', async () => {
    const { deps, stored, asked } = harness([lane('a'), lane('b')], 'runner unavailable: offline');
    expect(await checkLaneConflicts(deps, 'f1')).toBe('failed');
    expect(stored.size).toBe(0);

    expect(await checkLaneConflicts(deps, 'f1')).toBe('not-due');
    expect(asked).toHaveLength(1);

    deps.now = () => NOW + LANE_CONFLICT_RETRY_MS;
    expect(await checkLaneConflicts(deps, 'f1')).toBe('failed');
    expect(asked).toHaveLength(2);
  });

  test('does nothing for a factory with fewer than two active lanes', async () => {
    const { deps, asked } = harness([lane('a')], {
      kind: 'checked',
      conflicts: [],
      missing: [],
      fetched: true,
    });
    expect(await checkLaneConflicts(deps, 'f1')).toBe('not-due');
    expect(asked).toEqual([]);
  });
});
