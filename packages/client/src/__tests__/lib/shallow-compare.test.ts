import type { Thread } from '@funny/shared';
import { describe, test, expect } from 'vitest';

import { arraysEqual, threadsVisuallyEqual } from '@/lib/shallow-compare';

// ── arraysEqual ──────────────────────────────────────────────────

describe('arraysEqual', () => {
  test('returns true for same reference', () => {
    const arr = [1, 2, 3];
    expect(arraysEqual(arr, arr)).toBe(true);
  });

  test('returns true for identical content', () => {
    expect(arraysEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  test('returns false for different lengths', () => {
    expect(arraysEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  test('returns false for different elements', () => {
    expect(arraysEqual([1, 2, 3], [1, 2, 4])).toBe(false);
  });

  test('returns true for empty arrays', () => {
    expect(arraysEqual([], [])).toBe(true);
  });

  test('uses custom comparator', () => {
    const a = [{ id: 1 }, { id: 2 }];
    const b = [{ id: 1 }, { id: 2 }];
    expect(arraysEqual(a, b, (x, y) => x.id === y.id)).toBe(true);
  });

  test('custom comparator can detect differences', () => {
    const a = [{ id: 1 }];
    const b = [{ id: 2 }];
    expect(arraysEqual(a, b, (x, y) => x.id === y.id)).toBe(false);
  });

  test('uses Object.is by default (NaN === NaN)', () => {
    expect(arraysEqual([NaN], [NaN])).toBe(true);
  });

  test('differentiates 0 and -0 with Object.is', () => {
    expect(arraysEqual([0], [-0])).toBe(false);
  });
});

// ── threadsVisuallyEqual ─────────────────────────────────────────

/** Helper to build a minimal Thread-shaped object. */
function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    projectId: 'p1',
    userId: 'u1',
    title: 'Test Thread',
    mode: 'local',
    status: 'completed',
    stage: 'done',
    provider: 'claude-sdk',
    permissionMode: 'plan',
    model: 'sonnet',
    cost: 0,
    source: 'user',
    purpose: 'code',
    runtime: 'local',
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  } as Thread;
}

describe('threadsVisuallyEqual', () => {
  test('returns true for same reference', () => {
    const t = makeThread();
    expect(threadsVisuallyEqual(t, t)).toBe(true);
  });

  test('returns true when all visual keys match', () => {
    const a = makeThread();
    const b = makeThread();
    expect(threadsVisuallyEqual(a, b)).toBe(true);
  });

  test('returns false when title differs', () => {
    const a = makeThread({ title: 'A' });
    const b = makeThread({ title: 'B' });
    expect(threadsVisuallyEqual(a, b)).toBe(false);
  });

  test('returns false when status differs', () => {
    const a = makeThread({ status: 'running' });
    const b = makeThread({ status: 'completed' });
    expect(threadsVisuallyEqual(a, b)).toBe(false);
  });

  test('returns false when branch differs', () => {
    const a = makeThread({ branch: 'feat-a' });
    const b = makeThread({ branch: 'feat-b' });
    expect(threadsVisuallyEqual(a, b)).toBe(false);
  });

  test('returns false when pinned differs', () => {
    const a = makeThread({ pinned: true });
    const b = makeThread({ pinned: false });
    expect(threadsVisuallyEqual(a, b)).toBe(false);
  });

  test('returns false when archived differs', () => {
    const a = makeThread({ archived: true });
    const b = makeThread({ archived: false });
    expect(threadsVisuallyEqual(a, b)).toBe(false);
  });

  test('ignores cost changes', () => {
    const a = makeThread({ cost: 0.1 });
    const b = makeThread({ cost: 9.9 });
    expect(threadsVisuallyEqual(a, b)).toBe(true);
  });

  test('ignores sessionId changes', () => {
    const a = makeThread({ sessionId: 'sess-1' });
    const b = makeThread({ sessionId: 'sess-2' });
    expect(threadsVisuallyEqual(a, b)).toBe(true);
  });

  test('ignores stage changes', () => {
    const a = makeThread({ stage: 'backlog' });
    const b = makeThread({ stage: 'in_progress' });
    expect(threadsVisuallyEqual(a, b)).toBe(true);
  });
});
