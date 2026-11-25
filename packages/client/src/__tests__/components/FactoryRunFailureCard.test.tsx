import { beforeEach, describe, expect, test, vi, type Mock, mock } from 'bun:test';

import type { Thread } from '@funny/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';

import { TooltipProvider } from '@/components/ui/tooltip';
import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryRun } from '@/lib/api/factory';

interface FailureCardMocks {
  run: FactoryRun | null;
  thread: Pick<Thread, 'id' | 'projectId' | 'source'> | undefined;
  control: Mock<(...args: any[]) => any>;
  approve: Mock<(...args: any[]) => any>;
}

const mocks = ((): FailureCardMocks => ({
  run: null,
  thread: { id: 't1', projectId: 'p1', source: 'factory' },
  control: vi.fn(),
  approve: vi.fn(),
}))();

mock.module('@/data/factory/hooks', () => ({ useFactoryRunForThread: () => mocks.run }));
mock.module('@/lib/thread-selectors', () => ({ useThreadById: () => mocks.thread }));
mock.module('@/data/projects/hooks', () => ({ useCanSteerProject: () => true }));
mock.module('@/data/factory/actions', () => ({
  controlFactoryRun: (...args: unknown[]) => mocks.control(...args),
  approveFactoryMerge: (...args: unknown[]) => mocks.approve(...args),
}));
const toastError = vi.fn();
mock.module('@/lib/toast-error', () => ({ toastError }));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    // A fallback string with its values, or `{ defaultValue, ...values }` (PRBadge's form).
    t: (
      _k: string,
      fallback?: string | Record<string, unknown>,
      vars?: Record<string, unknown>,
    ) => {
      const values = typeof fallback === 'string' ? vars : fallback;
      const text = typeof fallback === 'string' ? fallback : String(values?.defaultValue ?? _k);
      return text.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(values?.[name] ?? ''));
    },
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
  mocks.approve.mockReset();
  mocks.approve.mockImplementation(() => okAsync(runOf({ state: 'queued' })));
});

describe('FactoryRunFailureCard', () => {
  test('shows where the pipeline stopped, why, and lets the member retry it', () => {
    render(<FactoryRunFailureCard threadId="t1" agentRunning={false} />, {
      wrapper: TooltipProvider,
    });
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
    render(<FactoryRunFailureCard threadId="t1" agentRunning={false} />, {
      wrapper: TooltipProvider,
    });
    const card = screen.getByTestId('factory-run-failure-card');
    expect(card).toHaveTextContent('Not merged: high risk, it needs you');
    expect(card).not.toHaveTextContent('The factory pipeline stopped at merge');
    expect(screen.getByTestId('factory-run-failure-detail')).toHaveTextContent(
      'touches a sensitive path: packages/server/src/db/migrate.ts',
    );
    expect(screen.getByTestId('factory-run-failure-detail')).toHaveTextContent('merge it yourself');
  });

  test('a high-risk hold offers "Approve and merge" instead of Retry, after a confirmation', async () => {
    mocks.run = runOf({
      currentStep: 'merge',
      failureReason: 'high risk',
      risk: {
        headSha: 'c2b585c51b2e',
        level: 'high',
        reasons: [
          'touches a sensitive path: packages/server/src/db/migrate.ts (**/migrate.ts)',
          '1511 changed lines outside tests and docs (more than 400)',
        ],
        changedLines: 345,
        paths: ['packages/server/src/db/migrate.ts'],
      },
    });
    render(<FactoryRunFailureCard threadId="t1" agentRunning={false} />, {
      wrapper: TooltipProvider,
    });
    // Retry would hold the same commit again: it is not offered.
    expect(screen.queryByTestId('factory-run-failure-retry')).not.toBeInTheDocument();
    expect(screen.getByTestId('factory-run-failure-pr')).toHaveTextContent('#9');

    fireEvent.click(screen.getByTestId('factory-run-failure-approve-merge'));
    expect(mocks.control).not.toHaveBeenCalled();
    expect(await screen.findByText('Merge this high-risk change?')).toBeInTheDocument();
    // One line per risk reason, not one run-on sentence.
    const reasons = within(screen.getByTestId('factory-approve-merge-reasons')).getAllByRole(
      'listitem',
    );
    expect(reasons.map((item) => item.textContent)).toEqual([
      'touches a sensitive path: packages/server/src/db/migrate.ts (**/migrate.ts)',
      '1511 changed lines outside tests and docs (more than 400)',
    ]);
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    // The approval names the commit the dialog showed.
    expect(mocks.approve).toHaveBeenCalledWith('p1', 'r1', 'c2b585c51b2e');
    expect(mocks.control).not.toHaveBeenCalled();
  });

  test('an approval refused because the commit changed says so', async () => {
    mocks.run = runOf({
      currentStep: 'merge',
      failureReason: 'high risk',
      risk: { headSha: 'c2b585c51b2e', level: 'high', reasons: [], changedLines: 3, paths: [] },
    });
    const conflict = { type: 'CONFLICT', message: 'held on another commit' };
    mocks.approve.mockImplementation(() => errAsync(conflict));
    render(<FactoryRunFailureCard threadId="t1" agentRunning={false} />, {
      wrapper: TooltipProvider,
    });
    fireEvent.click(screen.getByTestId('factory-run-failure-approve-merge'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(conflict, 'factoryApprove'));
  });

  test('a run held for another reason keeps Retry and offers no approval', () => {
    mocks.run = runOf({ currentStep: 'merge', failureReason: 'review failed' });
    render(<FactoryRunFailureCard threadId="t1" agentRunning={false} />, {
      wrapper: TooltipProvider,
    });
    expect(screen.getByTestId('factory-run-failure-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('factory-run-failure-approve-merge')).not.toBeInTheDocument();
  });

  test('a failed run without a known step still shows its error', () => {
    mocks.run = runOf({ state: 'failed', currentStep: null, failureReason: 'merge conflict' });
    render(<FactoryRunFailureCard threadId="t1" agentRunning={false} />, {
      wrapper: TooltipProvider,
    });
    const card = screen.getByTestId('factory-run-failure-card');
    expect(card).toHaveTextContent('The factory pipeline stopped on an error');
    expect(card).toHaveTextContent('merge conflict');
  });

  test('shows nothing while the run works, waits without an error, the agent runs, or for another thread', () => {
    mocks.run = runOf({ state: 'waiting_ci', failureReason: null });
    const { rerender } = render(<FactoryRunFailureCard threadId="t1" agentRunning={false} />, {
      wrapper: TooltipProvider,
    });
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
