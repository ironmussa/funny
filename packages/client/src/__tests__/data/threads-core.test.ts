import type { Thread } from '@funny/shared';
import { describe, expect, test } from 'vitest';

import {
  fenceFields,
  mergeIncomingThread,
  takeFencedFields,
  type FieldFences,
} from '@/data/threads/merge';
import { compareThreadsForList, threadActivityTime } from '@/data/threads/order';

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

describe('thread order (parity with the server list query)', () => {
  // Server: ORDER BY pinned DESC, COALESCE(completedAt, createdAt) DESC
  function serverOrder(rows: Thread[]): string[] {
    return [...rows]
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const pinned = Number(!!b.row.pinned) - Number(!!a.row.pinned);
        if (pinned) return pinned;
        const at = Date.parse(a.row.completedAt ?? a.row.createdAt);
        const bt = Date.parse(b.row.completedAt ?? b.row.createdAt);
        return bt - at || a.index - b.index;
      })
      .map(({ row }) => row.id);
  }

  test('matches pinned-first then activity-desc, with ties stable', () => {
    const rows = [
      thread('old', { createdAt: '2026-01-01T00:00:00.000Z' }),
      thread('completed-late', {
        createdAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-03-01T00:00:00.000Z',
      }),
      thread('new', { createdAt: '2026-02-01T00:00:00.000Z' }),
      thread('pinned-old', { pinned: true, createdAt: '2025-01-01T00:00:00.000Z' }),
      thread('tie-a', { createdAt: '2026-02-01T00:00:00.000Z' }),
    ];
    expect([...rows].sort(compareThreadsForList).map((t) => t.id)).toEqual(serverOrder(rows));
    expect([...rows].sort(compareThreadsForList).map((t) => t.id)).toEqual([
      'pinned-old',
      'completed-late',
      'new',
      'tie-a',
      'old',
    ]);
  });

  test('activity time falls back to createdAt and tolerates bad dates', () => {
    expect(threadActivityTime({ createdAt: '2026-01-01T00:00:00.000Z' })).toBe(
      Date.parse('2026-01-01T00:00:00.000Z'),
    );
    expect(threadActivityTime({ createdAt: 'not-a-date' })).toBe(0);
  });
});

describe('mergeIncomingThread', () => {
  test('a terminal local row beats an older active incoming row', () => {
    const local = thread('t', { status: 'completed', updatedAt: '2026-01-02T00:00:00.000Z' });
    const stale = thread('t', { status: 'running', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(mergeIncomingThread(local, stale)).toBe(local);
  });

  test('a newer active incoming row wins (follow-up run started elsewhere)', () => {
    const local = thread('t', { status: 'completed', updatedAt: '2026-01-01T00:00:00.000Z' });
    const newer = thread('t', { status: 'running', updatedAt: '2026-01-02T00:00:00.000Z' });
    expect(mergeIncomingThread(local, newer)).toBe(newer);
  });

  test('an equal incoming row keeps the held reference', () => {
    const local = thread('t');
    expect(mergeIncomingThread(local, { ...local })).toBe(local);
  });

  test('fenced fields keep the held value while other fields apply', () => {
    const local = thread('t', { archived: true, status: 'idle' });
    const incoming = thread('t', { archived: false, status: 'running' });
    const merged = mergeIncomingThread(local, incoming, new Set(['archived']));
    expect(merged.archived).toBe(true);
    expect(merged.status).toBe('running');
  });
});

describe('field fences', () => {
  test('a response started before the fence is fenced; one started after clears it', () => {
    const fences: FieldFences = new Map();
    fenceFields(fences, 't', ['archived'], 5);

    expect([...takeFencedFields(fences, 't', 4)]).toEqual(['archived']);
    expect(fences.has('t')).toBe(true);

    expect([...takeFencedFields(fences, 't', 6)]).toEqual([]);
    expect(fences.has('t')).toBe(false);
  });
});
