import { describe, expect, test } from 'bun:test';

import type { Thread } from '@funny/shared';

import {
  formatSidebarRelativeTime,
  recentSidebarThreads,
  sidebarThreadStatus,
  sidebarThreadSummary,
  visibleProjectThreads,
} from '../sidebar-model';

function thread(overrides: Partial<Thread> & Pick<Thread, 'id'>): Thread {
  return {
    projectId: 'p1',
    userId: 'u1',
    title: overrides.id,
    mode: 'worktree',
    status: 'idle',
    stage: 'in_progress',
    provider: 'codex',
    permissionMode: 'ask',
    model: 'gpt-5',
    cost: 0,
    source: 'web',
    runtime: 'local',
    createdAt: '2026-08-30T10:00:00.000Z',
    updatedAt: '2026-08-30T10:00:00.000Z',
    ...overrides,
  } as Thread;
}

describe('native sidebar model', () => {
  test('orders activity by recency and project rows by pin then recency', () => {
    const rows = [
      thread({ id: 'old', updatedAt: '2026-08-30T10:00:00.000Z' }),
      thread({ id: 'new', updatedAt: '2026-08-30T12:00:00.000Z' }),
      thread({ id: 'pin', pinned: true, updatedAt: '2026-08-30T09:00:00.000Z' }),
      thread({ id: 'archived', archived: true, updatedAt: '2026-08-30T13:00:00.000Z' }),
    ];
    expect(recentSidebarThreads(rows).map((row) => row.id)).toEqual(['new', 'old', 'pin']);
    expect(visibleProjectThreads(rows).map((row) => row.id)).toEqual(['pin', 'new', 'old']);
  });

  test('maps state and compact metadata without renderer dependencies', () => {
    const now = Date.parse('2026-08-30T12:00:00.000Z');
    expect(formatSidebarRelativeTime('2026-08-30T11:37:00.000Z', now)).toBe('23m');
    expect(formatSidebarRelativeTime('2026-08-29T12:00:00.000Z', now)).toBe('1d');
    expect(sidebarThreadStatus('pending')).toBe('setting-up');
    expect(sidebarThreadStatus('interrupted')).toBe('idle');
    expect(sidebarThreadSummary(thread({ id: 'a', status: 'waiting' }))).toBe('Waiting for input');
    expect(
      sidebarThreadSummary(thread({ id: 'b', lastAssistantMessage: '  Result ready  ' })),
    ).toBe('Result ready');
    expect(
      sidebarThreadSummary(thread({ id: 'c', lastAssistantMessage: 'First line\n\nSecond line' })),
    ).toBe('First line Second line');
  });
});
