/**
 * The review-fix loop removes the corrector's worktree once it has read the
 * corrector's changes (track-pipeline-runs, design D2), whether the corrector
 * changed anything or not; the patch is kept in the context.
 */
import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import { ok } from 'neverthrow';

const mocks = (() => ({
  gitRead: vi.fn(),
  cleanupReviewerThread: vi.fn(async (_threadId: string, _projectId: string) => undefined),
  createAndStartThread: vi.fn(async () => ok({ id: 'corrector-1' })),
  getThread: vi.fn(async () => ({ id: 'corrector-1', worktreePath: '/wt/corrector' })),
}))();

mock.module('@funny/core/git', () => ({ gitRead: mocks.gitRead, gitWrite: vi.fn() }));
mock.module('../../services/pipeline-manager.js', () => ({
  parseReviewVerdict: vi.fn(),
  cleanupReviewerThread: mocks.cleanupReviewerThread,
}));
mock.module('../../services/thread-service/create.js', () => ({
  createAndStartThread: mocks.createAndStartThread,
}));
mock.module('../../services/thread-manager.js', () => ({ getThread: mocks.getThread }));
mock.module('../../services/workflow-event-helpers.js', () => ({
  emitWorkflowEvent: vi.fn(async () => undefined),
}));
mock.module('../../services/git-pipelines/agent-completion.js', () => ({
  waitForAgentCompletion: vi.fn(async () => undefined),
}));
mock.module('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { reviewFixSubPipeline } = await import('../../services/git-pipelines/review-fix.js');

const fixNode = reviewFixSubPipeline.nodes.find((n) => n.name === 'fix')!;

const ctx = {
  threadId: 't1',
  projectId: 'p1',
  userId: 'u1',
  iteration: 1,
  findings: 'a finding',
  fixModel: 'sonnet',
  setStep: vi.fn(),
} as never;

describe('review-fix corrector cleanup', () => {
  beforeEach(() => {
    mocks.gitRead.mockReset();
    mocks.cleanupReviewerThread.mockClear();
  });

  test('a corrector that changed files: the patch is read, then its worktree removed', async () => {
    mocks.gitRead.mockImplementation(async (args: string[]) => {
      if (args[0] === 'status') return { exitCode: 0, stdout: ' M a.ts\n' };
      if (args[0] === 'diff') return { exitCode: 0, stdout: 'diff --git a/a.ts b/a.ts\n' };
      return { exitCode: 0, stdout: '' };
    });

    const next = (await fixNode.execute(ctx, new AbortController().signal, {} as never)) as any;

    expect(next.patchDiff).toContain('diff --git');
    expect(mocks.cleanupReviewerThread).toHaveBeenCalledWith('corrector-1', 'p1');
    // The diff was read before the cleanup ran.
    const diffCall = mocks.gitRead.mock.invocationCallOrder.at(-1)!;
    expect(diffCall).toBeLessThan(mocks.cleanupReviewerThread.mock.invocationCallOrder[0]!);
  });

  test('a corrector that changed nothing is cleaned up too', async () => {
    mocks.gitRead.mockResolvedValue({ exitCode: 0, stdout: '' });

    const next = (await fixNode.execute(ctx, new AbortController().signal, {} as never)) as any;

    expect(next.noChanges).toBe(true);
    expect(mocks.cleanupReviewerThread).toHaveBeenCalledWith('corrector-1', 'p1');
  });

  test('a failed diff still cleans the corrector up', async () => {
    mocks.gitRead.mockImplementation(async (args: string[]) =>
      args[0] === 'status' ? { exitCode: 0, stdout: ' M a.ts\n' } : { exitCode: 1, stdout: '' },
    );

    await expect(fixNode.execute(ctx, new AbortController().signal, {} as never)).rejects.toThrow();
    expect(mocks.cleanupReviewerThread).toHaveBeenCalledWith('corrector-1', 'p1');
  });
});
