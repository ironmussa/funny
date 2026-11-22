import { describe, expect, test } from 'bun:test';

import type { Thread } from '@funny/shared';

import { groupThreadsByWorktree } from '@/components/WorktreeSettings';

const MAIN = { path: '/repo', branch: 'master', commit: 'a', isMain: true };
const LINKED = { path: '/wt/feat-x', branch: 'feat/x', commit: 'b', isMain: false };

function thread(partial: Partial<Thread> & { id: string }): Thread {
  return { projectId: 'p1', title: partial.id, mode: 'worktree', ...partial } as Thread;
}

describe('groupThreadsByWorktree', () => {
  test('matches a thread by its worktree path, ignoring a trailing slash', () => {
    const map = groupThreadsByWorktree(
      [MAIN, LINKED],
      [thread({ id: 't1', worktreePath: '/wt/feat-x/' })],
    );
    expect(map.get('/wt/feat-x')?.map((t) => t.id)).toEqual(['t1']);
  });

  test('falls back to the branch for a worktree thread without a recorded path', () => {
    const map = groupThreadsByWorktree([MAIN, LINKED], [thread({ id: 't2', branch: 'feat/x' })]);
    expect(map.get('/wt/feat-x')?.map((t) => t.id)).toEqual(['t2']);
  });

  test('never claims local threads for the main checkout by branch', () => {
    const map = groupThreadsByWorktree(
      [MAIN, LINKED],
      [thread({ id: 't3', mode: 'local', branch: 'master' })],
    );
    expect(map.size).toBe(0);
  });

  test('skips archived threads', () => {
    const map = groupThreadsByWorktree(
      [LINKED],
      [thread({ id: 't4', worktreePath: '/wt/feat-x', archived: true })],
    );
    expect(map.size).toBe(0);
  });
});
