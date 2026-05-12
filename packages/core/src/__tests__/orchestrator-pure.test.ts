/**
 * Phase 2 — pure logic tests for the orchestrator core.
 * Covers backoff, stall, priority, eligibility, and the planner.
 */

import type { Thread } from '@funny/shared';
import { describe, expect, test } from 'vitest';

import {
  checkEligibility,
  countRunningForUser,
  isStalled,
  nextRetryDelayMs,
  planDispatch,
  sortByPriority,
  type EligibilityInput,
  type RetryEntry,
  type RunRef,
} from '../orchestrator/index.js';

// ── Fixtures ──────────────────────────────────────────────────

function makeThread(over: Partial<Thread> & Pick<Thread, 'id' | 'userId' | 'createdAt'>): Thread {
  return {
    projectId: 'p1',
    title: 't',
    mode: 'local',
    status: 'pending',
    stage: 'backlog',
    provider: 'claude',
    permissionMode: 'autoEdit',
    model: 'sonnet',
    cost: 0,
    source: 'web',
    runtime: 'local',
    updatedAt: over.createdAt,
    ...over,
  } as Thread;
}

function emptyInput(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    candidates: [],
    running: new Map(),
    claimed: new Set(),
    retryQueue: new Map(),
    dependencies: new Map(),
    terminalThreadIds: new Set(),
    slots: { maxConcurrentGlobal: 4, maxConcurrentPerUser: 2 },
    now: 1_000_000,
    ...over,
  };
}

// ── Backoff ──────────────────────────────────────────────────

describe('nextRetryDelayMs', () => {
  test('attempt <= 0 → 1s (post-cancellation continuation)', () => {
    expect(nextRetryDelayMs(0)).toBe(1_000);
    expect(nextRetryDelayMs(-3)).toBe(1_000);
  });

  test('exponential ramp: 10s, 20s, 40s, 80s, …', () => {
    expect(nextRetryDelayMs(1)).toBe(10_000);
    expect(nextRetryDelayMs(2)).toBe(20_000);
    expect(nextRetryDelayMs(3)).toBe(40_000);
    expect(nextRetryDelayMs(4)).toBe(80_000);
  });

  test('caps at maxBackoffMs (default 5 min)', () => {
    expect(nextRetryDelayMs(20)).toBe(300_000);
    expect(nextRetryDelayMs(100)).toBe(300_000);
  });

  test('honours custom cap', () => {
    expect(nextRetryDelayMs(20, 60_000)).toBe(60_000);
  });

  test('handles non-finite gracefully', () => {
    expect(nextRetryDelayMs(NaN)).toBe(1_000);
    expect(nextRetryDelayMs(Infinity, 60_000)).toBe(1_000);
  });
});

// ── Stall ────────────────────────────────────────────────────

describe('isStalled', () => {
  const run: RunRef = {
    threadId: 't1',
    userId: 'u1',
    attempt: 0,
    lastEventAtMs: 1_000,
    pipelineRunId: null,
  };

  test('returns false when within timeout', () => {
    expect(isStalled(run, 5_000, 4_999)).toBe(false);
    expect(isStalled(run, 5_000, 6_000)).toBe(false); // 5_000 elapsed, == timeout
  });

  test('returns true when elapsed > timeout', () => {
    expect(isStalled(run, 5_000, 6_001)).toBe(true);
  });

  test('disabled when timeout <= 0', () => {
    expect(isStalled(run, 0, 1_000_000)).toBe(false);
    expect(isStalled(run, -1, 1_000_000)).toBe(false);
  });

  test('clock skew (now < lastEventAtMs) is not stall', () => {
    expect(isStalled(run, 5_000, 0)).toBe(false);
  });
});

// ── Priority sort ────────────────────────────────────────────

describe('sortByPriority', () => {
  test('oldest createdAt first, ties broken by id', () => {
    const t1 = makeThread({ id: 'b', userId: 'u', createdAt: '2026-01-01T00:00:00Z' });
    const t2 = makeThread({ id: 'a', userId: 'u', createdAt: '2026-01-01T00:00:00Z' });
    const t3 = makeThread({ id: 'c', userId: 'u', createdAt: '2026-01-02T00:00:00Z' });

    const sorted = sortByPriority([t3, t1, t2]);
    expect(sorted.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  test('does not mutate input', () => {
    const list = [
      makeThread({ id: 'b', userId: 'u', createdAt: '2026-02-01T00:00:00Z' }),
      makeThread({ id: 'a', userId: 'u', createdAt: '2026-01-01T00:00:00Z' }),
    ];
    const ids = list.map((t) => t.id);
    sortByPriority(list);
    expect(list.map((t) => t.id)).toEqual(ids);
  });
});

// ── Eligibility ──────────────────────────────────────────────

describe('checkEligibility', () => {
  const t = makeThread({ id: 't1', userId: 'u1', createdAt: '2026-01-01T00:00:00Z' });

  test('eligible when nothing in the way', () => {
    const res = checkEligibility(t, emptyInput());
    expect(res).toEqual({ eligible: true });
  });

  test('rejects already-claimed', () => {
    const res = checkEligibility(t, emptyInput({ claimed: new Set(['t1']) }));
    expect(res).toEqual({ eligible: false, reason: 'already-claimed' });
  });

  test('rejects already-running', () => {
    const running = new Map<string, RunRef>([
      ['t1', { threadId: 't1', userId: 'u1', attempt: 0, lastEventAtMs: 0, pipelineRunId: null }],
    ]);
    const res = checkEligibility(t, emptyInput({ running }));
    expect(res).toEqual({ eligible: false, reason: 'already-running' });
  });

  test('rejects when in retry queue', () => {
    const retryQueue = new Map<string, RetryEntry>([
      [
        't1',
        { threadId: 't1', userId: 'u1', attempt: 1, nextRetryAtMs: 999_999_999, lastError: 'x' },
      ],
    ]);
    const res = checkEligibility(t, emptyInput({ retryQueue }));
    expect(res).toEqual({ eligible: false, reason: 'in-retry-queue' });
  });

  test('rejects when blocked by a non-terminal dependency', () => {
    const dependencies = new Map([['t1', ['blocker-1']]]);
    const res = checkEligibility(t, emptyInput({ dependencies }));
    expect(res).toEqual({ eligible: false, reason: 'blocked-by-dependency' });
  });

  test('eligible when every blocker is terminal', () => {
    const dependencies = new Map([['t1', ['b1', 'b2']]]);
    const terminalThreadIds = new Set(['b1', 'b2']);
    const res = checkEligibility(t, emptyInput({ dependencies, terminalThreadIds }));
    expect(res).toEqual({ eligible: true });
  });

  test('blocked when one blocker is still active', () => {
    const dependencies = new Map([['t1', ['b1', 'b2']]]);
    const terminalThreadIds = new Set(['b1']);
    const res = checkEligibility(t, emptyInput({ dependencies, terminalThreadIds }));
    expect(res).toEqual({ eligible: false, reason: 'blocked-by-dependency' });
  });
});

describe('countRunningForUser', () => {
  test('counts only entries for the requested user', () => {
    const running = new Map<string, RunRef>([
      ['a', { threadId: 'a', userId: 'u1', attempt: 0, lastEventAtMs: 0, pipelineRunId: null }],
      ['b', { threadId: 'b', userId: 'u1', attempt: 0, lastEventAtMs: 0, pipelineRunId: null }],
      ['c', { threadId: 'c', userId: 'u2', attempt: 0, lastEventAtMs: 0, pipelineRunId: null }],
    ]);
    expect(countRunningForUser(running, 'u1')).toBe(2);
    expect(countRunningForUser(running, 'u2')).toBe(1);
    expect(countRunningForUser(running, 'u3')).toBe(0);
  });
});

// ── planDispatch ─────────────────────────────────────────────

describe('planDispatch', () => {
  test('rejects negative slot caps', () => {
    const result = planDispatch(
      emptyInput({ slots: { maxConcurrentGlobal: -1, maxConcurrentPerUser: 1 } }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('INVALID_INPUT');
  });

  test('dispatches eligible candidates oldest-first up to global slot cap', () => {
    const candidates = [
      makeThread({ id: 'c', userId: 'u1', createdAt: '2026-01-03T00:00:00Z' }),
      makeThread({ id: 'a', userId: 'u1', createdAt: '2026-01-01T00:00:00Z' }),
      makeThread({ id: 'b', userId: 'u1', createdAt: '2026-01-02T00:00:00Z' }),
    ];
    const input = emptyInput({
      candidates,
      slots: { maxConcurrentGlobal: 2, maxConcurrentPerUser: 5 },
    });

    const result = planDispatch(input);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.toDispatch.map((t) => t.id)).toEqual(['a', 'b']);
      expect(result.value.skipped).toContainEqual({
        threadId: 'c',
        reason: 'global-slots-exhausted',
      });
    }
  });

  test('respects per-user caps even when global slots remain', () => {
    const candidates = [
      makeThread({ id: 'a', userId: 'u1', createdAt: '2026-01-01T00:00:00Z' }),
      makeThread({ id: 'b', userId: 'u1', createdAt: '2026-01-02T00:00:00Z' }),
      makeThread({ id: 'c', userId: 'u1', createdAt: '2026-01-03T00:00:00Z' }),
      makeThread({ id: 'd', userId: 'u2', createdAt: '2026-01-04T00:00:00Z' }),
    ];
    const result = planDispatch(
      emptyInput({
        candidates,
        slots: { maxConcurrentGlobal: 10, maxConcurrentPerUser: 2 },
      }),
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const ids = result.value.toDispatch.map((t) => t.id);
      expect(ids).toContain('a');
      expect(ids).toContain('b');
      expect(ids).toContain('d');
      expect(ids).not.toContain('c');
      expect(result.value.skipped).toContainEqual({
        threadId: 'c',
        reason: 'user-slots-exhausted',
      });
    }
  });

  test('counts running threads against the same user cap', () => {
    const running = new Map<string, RunRef>([
      ['x', { threadId: 'x', userId: 'u1', attempt: 0, lastEventAtMs: 0, pipelineRunId: null }],
    ]);
    const candidates = [
      makeThread({ id: 'a', userId: 'u1', createdAt: '2026-01-01T00:00:00Z' }),
      makeThread({ id: 'b', userId: 'u1', createdAt: '2026-01-02T00:00:00Z' }),
    ];
    const result = planDispatch(
      emptyInput({
        candidates,
        running,
        slots: { maxConcurrentGlobal: 10, maxConcurrentPerUser: 2 },
      }),
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.toDispatch.map((t) => t.id)).toEqual(['a']);
      expect(result.value.skipped).toContainEqual({
        threadId: 'b',
        reason: 'user-slots-exhausted',
      });
    }
  });

  test('retries take priority and consume slots before fresh candidates', () => {
    const retryQueue = new Map<string, RetryEntry>([
      ['r1', { threadId: 'r1', userId: 'u1', attempt: 1, nextRetryAtMs: 999, lastError: 'e' }],
    ]);
    const candidates = [makeThread({ id: 'a', userId: 'u1', createdAt: '2026-01-01T00:00:00Z' })];
    const result = planDispatch(
      emptyInput({
        candidates,
        retryQueue,
        now: 1_000,
        slots: { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1 },
      }),
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.toRetry.map((r) => r.threadId)).toEqual(['r1']);
      expect(result.value.toDispatch).toEqual([]);
      expect(result.value.skipped).toContainEqual({
        threadId: 'a',
        reason: 'global-slots-exhausted',
      });
    }
  });

  test('retries before their due time stay queued', () => {
    const retryQueue = new Map<string, RetryEntry>([
      ['r1', { threadId: 'r1', userId: 'u1', attempt: 1, nextRetryAtMs: 5_000, lastError: 'e' }],
    ]);
    const result = planDispatch(emptyInput({ retryQueue, now: 1_000 }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.toRetry).toEqual([]);
    }
  });

  test('skips dependency-blocked candidates', () => {
    const candidates = [
      makeThread({ id: 'blocked', userId: 'u1', createdAt: '2026-01-01T00:00:00Z' }),
      makeThread({ id: 'free', userId: 'u1', createdAt: '2026-01-02T00:00:00Z' }),
    ];
    const dependencies = new Map([['blocked', ['gate']]]);
    const result = planDispatch(emptyInput({ candidates, dependencies }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.toDispatch.map((t) => t.id)).toEqual(['free']);
      expect(result.value.skipped).toContainEqual({
        threadId: 'blocked',
        reason: 'blocked-by-dependency',
      });
    }
  });

  test('zero global slots dispatches nothing', () => {
    const candidates = [makeThread({ id: 'a', userId: 'u1', createdAt: '2026-01-01T00:00:00Z' })];
    const result = planDispatch(
      emptyInput({ candidates, slots: { maxConcurrentGlobal: 0, maxConcurrentPerUser: 5 } }),
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.toDispatch).toEqual([]);
      expect(result.value.skipped).toContainEqual({
        threadId: 'a',
        reason: 'global-slots-exhausted',
      });
    }
  });
});
