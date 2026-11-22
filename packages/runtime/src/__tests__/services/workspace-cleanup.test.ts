/**
 * The workspace module (track-funny-actions, design D3): target validation,
 * processes stopped before removal, effects per step, one activity per cleanup.
 */
import { describe, expect, test } from 'bun:test';

import { badRequest, internal } from '@funny/shared/errors';
import { errAsync, okAsync } from 'neverthrow';

import { createActivityTracker } from '../../services/activity-tracker.js';
import {
  createWorkspaceCleanup,
  type WorkspaceCleanupDeps,
} from '../../services/workspace-cleanup.js';

const PROJECT = '/repo';
const WORKTREE = '/home/me/.funny/worktrees/repo/feature';

function setup(overrides: Partial<WorkspaceCleanupDeps> = {}) {
  const calls: string[] = [];
  const reports: { eventType: string; payload: any }[] = [];
  const tracker = createActivityTracker({
    reporter: {
      request: async (eventType, payload) => {
        reports.push({ eventType, payload });
        return { ok: true };
      },
    },
    emitToUser: () => {},
    retryTimes: 0,
    newId: () => 'act-1',
  });
  const cleanup = createWorkspaceCleanup({
    checkWorktreePathInProject: () => null,
    isRegisteredWorktreePath: () => okAsync(true),
    stopCommandsByCwd: async () => {
      calls.push('stop-commands');
      return ['dev server'];
    },
    killPtysUnderPath: () => {
      calls.push('kill-ptys');
      return ['zsh'];
    },
    invalidateSearchIndex: async () => {
      calls.push('invalidate');
    },
    removeWorktree: () => {
      calls.push('remove-worktree');
      return okAsync(undefined);
    },
    removeBranch: () => {
      calls.push('remove-branch');
      return okAsync(undefined);
    },
    pruneOrphanWorktrees: () => okAsync([]),
    removeDirectory: async () => {
      calls.push('rm');
    },
    pathExists: () => true,
    trackActivity: tracker.trackActivity,
    recordActivity: tracker.recordActivity,
    ...overrides,
  });
  const terminal = () => reports.find((r) => r.payload?.patch?.status)?.payload.patch;
  return { cleanup, calls, reports, tracker, terminal };
}

const REQUEST = {
  userId: 'u1',
  projectId: 'p1',
  projectPath: PROJECT,
  threadId: 't1',
  worktreePath: WORKTREE,
  branch: 'feature',
  deleteBranch: true,
  reason: 'thread-archived' as const,
};

describe('cleanupWorkspace', () => {
  test('stops processes, removes the worktree, deletes the branch and records it', async () => {
    const { cleanup, calls, reports, tracker, terminal } = setup();
    const result = await cleanup.cleanupWorkspace(REQUEST);
    await tracker.flush();

    expect(result.isOk()).toBe(true);
    expect(calls).toEqual([
      'stop-commands',
      'kill-ptys',
      'invalidate',
      'remove-worktree',
      'remove-branch',
    ]);
    expect(reports[0].payload).toMatchObject({
      kind: 'workspace.cleanup',
      origin: 'implicit',
      threadId: 't1',
      input: { reason: 'thread-archived', branch: 'feature', deleteBranch: true },
    });
    expect(terminal()).toEqual({
      status: 'succeeded',
      effects: [
        { effect: 'command-stopped', target: 'dev server' },
        { effect: 'terminal-closed', target: 'zsh' },
        { effect: 'worktree-removed', target: WORKTREE },
        { effect: 'branch-deleted', target: 'feature' },
      ],
    });
  });

  test('a manual cleanup is user-started', async () => {
    const { cleanup, reports, tracker } = setup();
    await cleanup.cleanupWorkspace({ ...REQUEST, reason: 'manual' });
    await tracker.flush();
    expect(reports[0].payload.origin).toBe('user');
  });

  test('refuses a path git does not list for the project, removing nothing', async () => {
    const { cleanup, calls, tracker, terminal } = setup({
      isRegisteredWorktreePath: () => okAsync(false),
    });
    const result = await cleanup.cleanupWorkspace(REQUEST);
    await tracker.flush();
    expect(result.isErr()).toBe(true);
    expect(calls).toEqual([]);
    expect(terminal().status).toBe('failed');
  });

  test('a worktree git no longer lists and whose folder is gone still has its branch deleted', async () => {
    const { cleanup, calls, tracker, terminal } = setup({
      isRegisteredWorktreePath: () => okAsync(false),
      pathExists: () => false,
    });
    const result = await cleanup.cleanupWorkspace(REQUEST);
    await tracker.flush();
    expect(result.isOk()).toBe(true);
    expect(calls).toEqual(['remove-branch']);
    expect(terminal()).toEqual({
      status: 'succeeded',
      effects: [{ effect: 'branch-deleted', target: 'feature' }],
    });
  });

  test('a worktree that cannot be removed still has its branch step, and the cleanup fails', async () => {
    const { cleanup, calls, tracker, terminal } = setup({
      removeWorktree: () => errAsync(internal('file locked')),
    });
    const result = await cleanup.cleanupWorkspace(REQUEST);
    await tracker.flush();
    expect(result._unsafeUnwrapErr().message).toBe('file locked');
    expect(calls).toContain('remove-branch');
    expect(terminal().status).toBe('failed');
    expect(terminal().effects).toContainEqual({ effect: 'branch-deleted', target: 'feature' });
  });

  test('refuses the main checkout', async () => {
    const { cleanup, calls } = setup();
    const result = await cleanup.cleanupWorkspace({ ...REQUEST, worktreePath: `${PROJECT}/` });
    expect(result._unsafeUnwrapErr().message).toContain('project checkout');
    expect(calls).toEqual([]);
  });

  test('refuses a path outside the worktree base', async () => {
    const { cleanup, calls } = setup({
      checkWorktreePathInProject: () => badRequest('outside the worktree base'),
    });
    expect((await cleanup.cleanupWorkspace(REQUEST)).isErr()).toBe(true);
    expect(calls).toEqual([]);
  });

  test('a failed branch deletion fails the activity and keeps the worktree effect', async () => {
    const { cleanup, tracker, terminal } = setup({
      removeBranch: () => errAsync(internal('branch is checked out')),
    });
    const result = await cleanup.cleanupWorkspace(REQUEST);
    await tracker.flush();
    expect(result.isErr()).toBe(true);
    const patch = terminal();
    expect(patch.status).toBe('failed');
    expect(patch.error).toContain('branch is checked out');
    expect(patch.effects).toContainEqual({ effect: 'worktree-removed', target: WORKTREE });
    expect(patch.effects).not.toContainEqual({ effect: 'branch-deleted', target: 'feature' });
  });

  test('keeps the branch when deleteBranch is false', async () => {
    const { cleanup, calls } = setup();
    await cleanup.cleanupWorkspace({ ...REQUEST, deleteBranch: false });
    expect(calls).not.toContain('remove-branch');
  });
});

describe('pruneOrphans', () => {
  test('records the removed folders', async () => {
    const { cleanup, reports, tracker } = setup({
      pruneOrphanWorktrees: () => okAsync(['/w/a', '/w/b']),
    });
    const result = await cleanup.pruneOrphans({
      userId: 'u1',
      projectId: 'p1',
      projectPath: PROJECT,
    });
    expect(result._unsafeUnwrap()).toBe(2);
    await tracker.flush();
    expect(reports).toHaveLength(1);
    expect(reports[0].payload).toMatchObject({
      kind: 'workspace.prune',
      status: 'succeeded',
      origin: 'implicit',
      effects: [
        { effect: 'directory-removed', target: '/w/a' },
        { effect: 'directory-removed', target: '/w/b' },
      ],
    });
  });

  test('records nothing when nothing was removed', async () => {
    const { cleanup, reports } = setup();
    await cleanup.pruneOrphans({ userId: 'u1', projectId: 'p1', projectPath: PROJECT });
    expect(reports).toHaveLength(0);
  });
});

describe('removeScratchWorkspace', () => {
  test('closes terminals, removes the directory and records it', async () => {
    const { cleanup, calls, tracker, terminal } = setup();
    const result = await cleanup.removeScratchWorkspace({
      userId: 'u1',
      threadId: 't1',
      scratchPath: '/home/me/.funny/scratch/u1/t1',
    });
    await tracker.flush();
    expect(result.isOk()).toBe(true);
    expect(calls.indexOf('kill-ptys')).toBeLessThan(calls.indexOf('rm'));
    expect(terminal().effects).toContainEqual({
      effect: 'directory-removed',
      target: '/home/me/.funny/scratch/u1/t1',
    });
  });
});
