/**
 * A merge records the switch of the main checkout when it moved it, and a
 * merge with cleanup removes the thread's workspace through the workspace
 * module (track-funny-actions, design D3), recorded with reason `merged`, and
 * a failed cleanup never fails the merge.
 */
import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import { internal } from '@funny/shared/errors';
import { errAsync, okAsync } from 'neverthrow';

const actualGit = await import('@funny/core/git');

const mocks = (() => ({
  merge: vi.fn(),
  cleanupWorkspace: vi.fn(),
  getCurrentBranch: vi.fn(),
  recordCheckoutSwitch: vi.fn(async () => undefined),
  getThread: vi.fn(),
  updateThread: vi.fn(async () => undefined),
}))();

mock.module('@funny/core/git', () => ({
  ...actualGit,
  mergeBranch: mocks.merge,
  git: vi.fn(() => okAsync('0')),
  invalidateStatusCache: vi.fn(),
  getCurrentBranch: mocks.getCurrentBranch,
}));
mock.module('../../services/checkout-activity.js', () => ({
  recordCheckoutSwitch: mocks.recordCheckoutSwitch,
}));
mock.module('../../services/workspace-cleanup.js', () => ({
  cleanupWorkspace: mocks.cleanupWorkspace,
}));
mock.module('../../services/thread-manager.js', () => ({
  getThread: mocks.getThread,
  updateThread: mocks.updateThread,
}));
mock.module('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));
mock.module('../../services/thread-event-bus.js', () => ({ threadEventBus: { emit: vi.fn() } }));
mock.module('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: { getProject: async () => ({ id: 'p1', path: '/repo' }) },
    profile: { getGitIdentity: async () => null, getGithubToken: async () => null },
  }),
}));

const { merge } = await import('../../services/git-service.js');

describe('merge cleanup', () => {
  beforeEach(() => {
    mocks.merge.mockReset().mockReturnValue(okAsync('merged'));
    mocks.getCurrentBranch.mockReset().mockReturnValue(okAsync('main'));
    mocks.recordCheckoutSwitch.mockClear();
    mocks.cleanupWorkspace.mockReset().mockReturnValue(okAsync({ effects: [] }));
    mocks.getThread.mockReset().mockResolvedValue({
      id: 't1',
      projectId: 'p1',
      userId: 'u1',
      branch: 'feature',
      baseBranch: 'main',
      worktreePath: '/wt/feature',
    });
  });

  test('cleans up the worktree and branch as a merged cleanup', async () => {
    const result = await merge({ threadId: 't1', userId: 'u1', cleanup: true });
    expect(result.isOk()).toBe(true);
    expect(mocks.cleanupWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: '/repo',
        worktreePath: '/wt/feature',
        branch: 'feature',
        deleteBranch: true,
        reason: 'merged',
        threadId: 't1',
      }),
    );
  });

  test('a failed cleanup does not fail the merge', async () => {
    mocks.cleanupWorkspace.mockReturnValue(errAsync(internal('branch is checked out')));
    const result = await merge({ threadId: 't1', userId: 'u1', cleanup: true });
    expect(result._unsafeUnwrap()).toBe('merged');
  });

  test('no cleanup requested, nothing removed', async () => {
    await merge({ threadId: 't1', userId: 'u1' });
    expect(mocks.cleanupWorkspace).not.toHaveBeenCalled();
  });

  test('a merge that moves the main checkout to the target branch records the switch', async () => {
    mocks.getCurrentBranch.mockReturnValue(okAsync('develop'));
    await merge({ threadId: 't1', userId: 'u1' });
    expect(mocks.recordCheckoutSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ fromBranch: 'develop', toBranch: 'main', reason: 'merged' }),
    );
  });

  test('a merge that leaves the main checkout where it was records none', async () => {
    await merge({ threadId: 't1', userId: 'u1' });
    expect(mocks.recordCheckoutSwitch).not.toHaveBeenCalled();
  });
});
