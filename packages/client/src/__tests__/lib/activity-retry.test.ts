import { describe, expect, test, vi } from 'vitest';

import { buildActivity } from '@/data/activities/testing';
import { canRetryActivity, retryActivity, type RetryDeps } from '@/lib/activity-retry';

function deps(thread: { id: string; projectId: string } | null = null): RetryDeps {
  return {
    navigate: vi.fn(),
    findThread: vi.fn(() => thread),
    openCloneForm: vi.fn(),
    openReviewPane: vi.fn(),
  };
}

describe('activity retry', () => {
  test('a failed clone opens the clone form with its input', () => {
    const d = deps();
    const activity = buildActivity({
      status: 'failed',
      input: { cloneUrl: 'https://github.com/acme/w.git', destinationPath: '/code', name: 'w' },
    });
    expect(retryActivity(activity, d)).toBe(true);
    expect(d.openCloneForm).toHaveBeenCalledWith({
      cloneUrl: 'https://github.com/acme/w.git',
      destinationPath: '/code',
      name: 'w',
    });
    expect(d.navigate).not.toHaveBeenCalled();
  });

  test('a worktree setup opens its thread', () => {
    const d = deps({ id: 't1', projectId: 'p1' });
    const activity = buildActivity({
      kind: 'worktree.setup',
      status: 'failed',
      projectId: 'p1',
      threadId: 't1',
      input: {},
    });
    retryActivity(activity, d);
    expect(d.navigate).toHaveBeenCalledWith('/projects/p1/threads/t1');
    expect(d.openReviewPane).not.toHaveBeenCalled();
  });

  test('a git workflow opens its thread with the review pane', () => {
    const d = deps({ id: 't1', projectId: 'p1' });
    const activity = buildActivity({
      kind: 'git.workflow',
      status: 'failed',
      projectId: 'p1',
      threadId: 't1',
      input: { action: 'push' },
    });
    retryActivity(activity, d);
    expect(d.navigate).toHaveBeenCalledWith('/projects/p1/threads/t1');
    expect(d.openReviewPane).toHaveBeenCalled();
  });

  test('falls back to the project when the thread is gone', () => {
    const d = deps(null);
    const activity = buildActivity({
      kind: 'git.workflow',
      status: 'failed',
      projectId: 'p1',
      threadId: 'deleted',
      input: { action: 'push' },
    });
    expect(retryActivity(activity, d)).toBe(true);
    expect(d.navigate).toHaveBeenCalledWith('/projects/p1');
    expect(d.openReviewPane).not.toHaveBeenCalled();
  });

  test('only failed or interrupted activities of a known kind offer a retry', () => {
    expect(canRetryActivity(buildActivity({ status: 'running' }))).toBe(false);
    expect(canRetryActivity(buildActivity({ status: 'succeeded' }))).toBe(false);
    expect(canRetryActivity(buildActivity({ status: 'interrupted' }))).toBe(true);
    expect(canRetryActivity(buildActivity({ status: 'failed', kind: 'unknown' }))).toBe(false);
  });
});
