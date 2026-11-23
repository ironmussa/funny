import { beforeEach, describe, expect, test, vi, type Mock, mock } from 'bun:test';

import type { Thread } from '@funny/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';

import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryRun } from '@/lib/api/factory';

interface FailureCardMocks {
  run: FactoryRun | null;
  thread: Pick<Thread, 'id' | 'projectId' | 'source'> | undefined;
  control: Mock<(...args: any[]) => any>;
}

const mocks = ((): FailureCardMocks => ({
  run: null,
  thread: { id: 't1', projectId: 'p1', source: 'factory' },
  control: vi.fn(),
}))();

mock.module('@/data/factory/hooks', () => ({ useFactoryRunForThread: () => mocks.run }));
mock.module('@/lib/thread-selectors', () => ({ useThreadById: () => mocks.thread }));
mock.module('@/data/projects/hooks', () => ({ useCanSteerProject: () => true }));
mock.module('@/data/factory/actions', () => ({
  controlFactoryRun: (...args: unknown[]) => mocks.control(...args),
}));
mock.module('@/lib/toast-error', () => ({ toastError: vi.fn() }));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string, vars?: Record<string, unknown>) =>
      (fallback ?? _k).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars?.[name] ?? '')),
  }),
}));

import { FactoryRunFailureCard } from '@/components/thread/FactoryRunFailureCard';

const runOf = (over: Partial<FactoryRun> = {}): FactoryRun =>
  buildFactoryRun({
    id: 'r1',
    issueNumber: 224,
    prUrl: 'https://github.com/o/r/pull/9',
    state: 'waiting_human',
    currentStep: 'ci',
    threadIds: ['t1'],
    startedAt: '2026-11-19T18:28:20.146Z',
    completedAt: null,
    source: 'manual',
    flowName: 'issue-to-merge',
    queueOrder: null,
    waitReason: null,
    flowSteps: ['implement', 'pull-request', 'ci', 'merge'],
    failureReason: 'wait_ci[ci] failed: Checks that need a person',
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run = runOf();
  mocks.thread = { id: 't1', projectId: 'p1', source: 'factory' };
  mocks.control.mockImplementation(() => okAsync(runOf({ state: 'queued' })));
});

describe('FactoryRunFailureCard', () => {
  test('shows where the pipeline stopped, why, and lets the member retry it', () => {
    render(<FactoryRunFailureCard threadId="t1" agentRunning={false} />);
    const card = screen.getByTestId('factory-run-failure-card');
    expect(card).toHaveTextContent('The factory pipeline stopped at ci');
    expect(card).toHaveTextContent('wait_ci[ci] failed: Checks that need a person');
    expect(card).toHaveTextContent('Factory · #224');
    expect(screen.getByTestId('factory-run-failure-pr')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('factory-run-failure-retry'));
    expect(mocks.control).toHaveBeenCalledWith('retry', 'p1', 'r1');
  });

  test('a merge held for high risk says so and names why, not just "high risk"', () => {
    mocks.run = runOf({
      currentStep: 'merge',
      failureReason: 'high risk',
      risk: {
        headSha: 'c2b585c',
        level: 'high',
        reasons: ['touches a sensitive path: packages/server/src/db/migrate.ts (**/migrate.ts)'],
        changedLines: 345,
        paths: ['packages/server/src/db/migrate.ts'],
      },
    });
    render(<FactoryRunFailureCard threadId="t1" agentRunning={false} />);
    const card = screen.getByTestId('factory-run-failure-card');
    expect(card).toHaveTextContent('Not merged: high risk, it needs you');
    expect(card).not.toHaveTextContent('The factory pipeline stopped at merge');
    expect(screen.getByTestId('factory-run-failure-detail')).toHaveTextContent(
      'touches a sensitive path: packages/server/src/db/migrate.ts',
    );
    expect(screen.getByTestId('factory-run-failure-detail')).toHaveTextContent('merge it yourself');
  });

  test('a failed run without a known step still shows its error', () => {
    mocks.run = runOf({ state: 'failed', currentStep: null, failureReason: 'merge conflict' });
    render(<FactoryRunFailureCard threadId="t1" agentRunning={false} />);
    const card = screen.getByTestId('factory-run-failure-card');
    expect(card).toHaveTextContent('The factory pipeline stopped on an error');
    expect(card).toHaveTextContent('merge conflict');
  });

  test('shows nothing while the run works, waits without an error, the agent runs, or for another thread', () => {
    mocks.run = runOf({ state: 'waiting_ci', failureReason: null });
    const { rerender } = render(<FactoryRunFailureCard threadId="t1" agentRunning={false} />);
    expect(screen.queryByTestId('factory-run-failure-card')).toBeNull();

    mocks.run = runOf({ failureReason: null });
    rerender(<FactoryRunFailureCard threadId="t1" agentRunning={false} />);
    expect(screen.queryByTestId('factory-run-failure-card')).toBeNull();

    mocks.run = runOf();
    rerender(<FactoryRunFailureCard threadId="t1" agentRunning />);
    expect(screen.queryByTestId('factory-run-failure-card')).toBeNull();

    mocks.thread = { id: 't1', projectId: 'p1', source: 'web' };
    rerender(<FactoryRunFailureCard threadId="t1" agentRunning={false} />);
    expect(screen.queryByTestId('factory-run-failure-card')).toBeNull();
  });
});
