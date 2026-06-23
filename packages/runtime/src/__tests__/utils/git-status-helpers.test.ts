import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@funny/core/git', () => ({
  invalidateStatusCache: vi.fn(),
  getPRForBranch: vi.fn(async () => null),
  getCurrentBranch: vi.fn(),
}));

import { getCurrentBranch } from '@funny/core/git';
import { ok } from 'neverthrow';

import type { HandlerServiceContext } from '../../services/handlers/types.js';
import { computeBranchKey, emitGitStatusForThread } from '../../utils/git-status-helpers.js';

function makeCtx(overrides: Partial<HandlerServiceContext> = {}): HandlerServiceContext {
  return {
    getThread: vi.fn(async () => ({
      id: 't-1',
      projectId: 'p-1',
      mode: 'local',
      branch: 'main',
      worktreePath: null,
      baseBranch: 'main',
      mergedAt: null,
    })),
    getProject: vi.fn(async () => ({ id: 'p-1', path: '/repo' })),
    getGitStatusSummary: vi.fn(async () =>
      ok({
        branch: 'main',
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
      }),
    ),
    deriveGitSyncState: vi.fn(() => 'clean'),
    invalidateGitStatusCache: vi.fn(),
    emitToUser: vi.fn(),
    updateThread: vi.fn(async () => undefined),
    log: vi.fn(),
    dequeueMessage: vi.fn(),
    enqueueMessage: vi.fn(),
    queueCount: vi.fn(),
    peekMessage: vi.fn(),
    startAgent: vi.fn(),
    broadcast: vi.fn(),
    insertComment: vi.fn(),
    saveThreadEvent: vi.fn(),
    ...overrides,
  } as HandlerServiceContext;
}

describe('computeBranchKey', () => {
  test('groups local threads on the same branch', () => {
    expect(
      computeBranchKey({
        id: 't-1',
        projectId: 'p-1',
        mode: 'local',
        branch: 'main',
      }),
    ).toBe('p-1:main');
  });

  test('uses unique key per worktree thread', () => {
    expect(
      computeBranchKey({
        id: 't-2',
        projectId: 'p-1',
        mode: 'worktree',
        branch: 'feature/x',
        worktreePath: '/wt/x',
      }),
    ).toBe('wt:p-1:feature/x:t-2');
  });

  test('uses thread id for merged threads without branch', () => {
    expect(
      computeBranchKey({
        id: 't-3',
        projectId: 'p-1',
        branch: null,
        worktreePath: null,
        baseBranch: 'main',
        mergedAt: '2025-01-01T00:00:00.000Z',
      }),
    ).toBe('tid:t-3');
  });
});

describe('emitGitStatusForThread', () => {
  beforeEach(() => {
    vi.mocked(getCurrentBranch).mockResolvedValue(ok('main'));
  });

  test('returns early when cwd is missing', async () => {
    const ctx = makeCtx();

    await emitGitStatusForThread({ threadId: 't-1', userId: 'u-1' }, ctx);

    expect(ctx.getGitStatusSummary).not.toHaveBeenCalled();
    expect(ctx.emitToUser).not.toHaveBeenCalled();
  });

  test('emits git:status payload for a valid thread', async () => {
    const ctx = makeCtx();

    await emitGitStatusForThread(
      { threadId: 't-1', userId: 'u-1', cwd: '/repo', detectBranchDrift: false },
      ctx,
    );

    expect(ctx.getGitStatusSummary).toHaveBeenCalledWith('/repo', 'main', '/repo');
    expect(ctx.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'git:status',
        threadId: 't-1',
      }),
    );
  });

  test('updates branch when drift detection finds a checkout change', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue(ok('feature/checkout'));
    const ctx = makeCtx({
      getThread: vi.fn(async () => ({
        id: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
        mode: 'local',
        branch: 'main',
        worktreePath: null,
        baseBranch: 'main',
      })),
    });

    await emitGitStatusForThread(
      { threadId: 't-1', userId: 'u-1', cwd: '/repo', detectBranchDrift: true },
      ctx,
    );

    expect(ctx.updateThread).toHaveBeenCalledWith('t-1', { branch: 'feature/checkout' });
    expect(ctx.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'thread:updated',
        data: { branch: 'feature/checkout' },
      }),
    );
  });
});
