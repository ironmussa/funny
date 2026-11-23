import { describe, expect, test, vi } from 'bun:test';

import { err, ok } from 'neverthrow';
/**
 * The helpers the git pipeline nodes share after `git-pipelines.ts` was split
 * (issue #233): the push / PR / merge nodes run through one `trackStep`
 * instead of three copies of the running → completed / failed pattern, and
 * git-service errors are unwrapped in one place.
 */

import { getActionPipeline, deriveSteps } from '../../services/git-pipelines.js';
import { waitForAgentCompletion } from '../../services/git-pipelines/agent-completion.js';
import type { GitPipelineContext } from '../../services/git-pipelines/context.js';
import {
  gitErrorMessage,
  trackStep,
  unwrapGit,
} from '../../services/git-pipelines/node-helpers.js';
import { threadEventBus } from '../../services/thread-event-bus.js';

function makeCtx(overrides: Partial<GitPipelineContext> = {}): GitPipelineContext {
  return {
    contextId: 'ctx-1',
    userId: 'user-1',
    cwd: '/repo',
    action: 'commit',
    hooks: [],
    pipelineEnabled: false,
    precommitFixEnabled: false,
    precommitFixModel: 'sonnet',
    precommitFixMaxIterations: 1,
    reviewModel: 'sonnet',
    fixModel: 'sonnet',
    maxReviewIterations: 1,
    testEnabled: false,
    testCommand: null,
    testFixEnabled: false,
    testFixModel: 'sonnet',
    testFixMaxIterations: 1,
    testOutput: null,
    testPassed: false,
    testIteration: 1,
    testFixerThreadId: null,
    commitSha: null,
    iteration: 1,
    reviewerThreadId: null,
    verdict: null,
    findings: null,
    correctorThreadId: null,
    patchDiff: null,
    noChanges: false,
    steps: [],
    workflowId: 'wf-1',
    setStep: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  };
}

describe('gitErrorMessage / unwrapGit', () => {
  test('a process error shows git stderr, any other error its message', () => {
    expect(gitErrorMessage({ type: 'PROCESS_ERROR', message: 'exit 1', stderr: 'rejected' })).toBe(
      'rejected',
    );
    expect(gitErrorMessage({ type: 'PROCESS_ERROR', message: 'exit 1', stderr: '' })).toBe(
      'exit 1',
    );
    expect(gitErrorMessage({ type: 'NOT_FOUND', message: 'no thread', stderr: 'x' })).toBe(
      'no thread',
    );
  });

  test('unwrapGit returns the value or throws the message', () => {
    expect(unwrapGit(ok('sha'))).toBe('sha');
    expect(() => unwrapGit(err({ type: 'PROCESS_ERROR', message: 'm', stderr: 'boom' }))).toThrow(
      'boom',
    );
  });
});

describe('trackStep', () => {
  test('marks the step running then completed with what the work returns', async () => {
    const ctx = makeCtx();
    await trackStep(ctx, 'pr', 'PR creation failed', async () => ({ url: 'https://pr/1' }));
    expect((ctx.setStep as any).mock.calls).toEqual([
      ['pr', { status: 'running' }],
      ['pr', { status: 'completed', url: 'https://pr/1' }],
    ]);
  });

  test('marks the step failed with the error message and rethrows it with the cause', async () => {
    const ctx = makeCtx();
    const cause = new Error('rejected by remote');
    const thrown = await trackStep(ctx, 'push', 'Push failed', async () => {
      throw cause;
    }).catch((e) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe('rejected by remote');
    expect(thrown.cause).toBe(cause);
    expect((ctx.setStep as any).mock.calls.at(-1)).toEqual([
      'push',
      { status: 'failed', error: 'rejected by remote' },
    ]);
  });

  test('falls back to the given message when the error has none', async () => {
    const ctx = makeCtx();
    const thrown = await trackStep(ctx, 'merge', 'Merge failed', async () => {
      throw new Error('');
    }).catch((e) => e);
    expect(thrown.message).toBe('Merge failed');
    expect((ctx.setStep as any).mock.calls.at(-1)).toEqual([
      'merge',
      { status: 'failed', error: 'Merge failed' },
    ]);
  });
});

describe('waitForAgentCompletion', () => {
  test('resolves on its own thread completing, ignores others, and removes its listener', async () => {
    const before = threadEventBus.listenerCount('agent:completed');
    const done = waitForAgentCompletion('t-1', new AbortController().signal);
    threadEventBus.emit('agent:completed', { threadId: 'other', status: 'failed' } as any);
    threadEventBus.emit('agent:completed', { threadId: 't-1', status: 'completed' } as any);
    expect(await done).toEqual({ status: 'completed' });
    expect(threadEventBus.listenerCount('agent:completed')).toBe(before);
  });

  test('rejects when the pipeline is cancelled and removes its listener', async () => {
    const before = threadEventBus.listenerCount('agent:completed');
    const controller = new AbortController();
    const done = waitForAgentCompletion('t-2', controller.signal);
    controller.abort();
    await expect(done).rejects.toThrow('Pipeline cancelled');
    expect(threadEventBus.listenerCount('agent:completed')).toBe(before);
  });

  test('rejects at once on an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForAgentCompletion('t-3', controller.signal)).rejects.toThrow(
      'Pipeline cancelled',
    );
  });
});

describe('deriveSteps', () => {
  test('a commit-pr workflow with review and tests lists every visible step in order', () => {
    const ctx = makeCtx({
      action: 'commit-pr',
      threadId: 'th-1',
      projectId: 'p-1',
      filesToStage: ['a.ts'],
      hooks: [{ label: 'lint', command: 'bun lint' }],
      pipelineEnabled: true,
      testEnabled: true,
      testCommand: 'bun test',
    });
    const steps = deriveSteps(getActionPipeline('commit-pr'), ctx);
    expect(steps.map((s) => s.id)).toEqual([
      'stage',
      'hooks',
      'commit',
      'review',
      'fix',
      'test-run',
      'test-fixer',
      'push',
      'pr',
    ]);
    expect(steps.find((s) => s.id === 'hooks')?.subItems).toEqual([
      { label: 'lint', status: 'pending' },
    ]);
  });

  test('an amend without a thread skips review, tests and labels the commit step', () => {
    const steps = deriveSteps(getActionPipeline('amend'), makeCtx({ action: 'amend' }));
    expect(steps).toEqual([
      { id: 'hooks', label: 'Running pre-commit hooks', status: 'pending' },
      { id: 'commit', label: 'Amending commit', status: 'pending' },
    ]);
  });
});
