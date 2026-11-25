/**
 * What a member sees of the regression proof gate (change
 * factory-quality-gates): the proof on a run's thread, the "no change"
 * outcome, and the "not configured" blocker on a queued issue.
 */
import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import type { Thread } from '@funny/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { MemoryRouter } from 'react-router-dom';

import { TooltipProvider } from '@/components/ui/tooltip';
import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryQueueRun, FactoryRegressionProof, FactoryRun } from '@/lib/api/factory';

const mocks = ((): {
  run: FactoryRun | null;
  queue: FactoryQueueRun[];
  thread: Pick<Thread, 'id' | 'projectId' | 'source'> | undefined;
} => ({
  run: null,
  queue: [],
  thread: { id: 't1', projectId: 'p1', source: 'factory' },
}))();

mock.module('@/data/factory/hooks', () => ({
  useFactoryRunForThread: () => mocks.run,
  useFactoryQueueRuns: () => mocks.queue,
}));
mock.module('@/lib/thread-selectors', () => ({ useThreadById: () => mocks.thread }));
mock.module('@/data/projects/hooks', () => ({
  useCanSteerProject: () => true,
  useProjects: () => [{ id: 'p1', name: 'funny' }],
}));
mock.module('@/data/factory/actions', () => ({
  approveFactoryMerge: () => okAsync(null),
  controlFactoryRun: () => okAsync(null),
}));
mock.module('@/hooks/use-stable-navigate', () => ({ useStableNavigate: () => vi.fn() }));
mock.module('@/hooks/use-minute-tick', () => ({ useMinuteTick: () => Date.now() }));
mock.module('@/lib/toast-error', () => ({ toastError: vi.fn() }));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    // `t(key, fallback, vars)` or `t(key, options)`, as the components call it.
    t: (
      key: string,
      fallback?: string | Record<string, unknown>,
      vars?: Record<string, unknown>,
    ) => {
      const text = typeof fallback === 'string' ? fallback : key;
      const values = typeof fallback === 'string' ? vars : fallback;
      return text.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(values?.[name] ?? ''));
    },
  }),
}));

import { FactoryQueueView } from '@/components/FactoryQueueView';
import { FactoryRunFailureCard } from '@/components/thread/FactoryRunFailureCard';
import { FactoryRunProofCard } from '@/components/thread/FactoryRunProofCard';

const proofOf = (over: Partial<FactoryRegressionProof>): FactoryRegressionProof => ({
  headSha: 'ea34890565ebb3a1de8c350b5dbc24c6ab3ee9c6',
  verdict: 'pass',
  files: ['packages/client/src/__tests__/components/PromptInput.test.tsx'],
  commands: ["bun test --parallel 'src/__tests__/components/PromptInput.test.tsx'"],
  baseSha: 'fcdad992bf83ff60cb62bfafae49a00758765448',
  outputTail: '(fail) keeps image attachments per thread\n 27 pass\n 1 fail',
  ranAt: '2026-11-22T10:00:00.000Z',
  ...over,
});

const runOf = (over: Partial<FactoryRun> = {}): FactoryRun =>
  buildFactoryRun({
    id: 'r1',
    issueNumber: 209,
    state: 'waiting_ci',
    threadIds: ['t1'],
    flowSteps: ['implement', 'pull-request', 'regression-proof', 'ci', 'merge'],
    ...over,
  });

beforeEach(() => {
  mocks.run = runOf();
  mocks.queue = [];
  mocks.thread = { id: 't1', projectId: 'p1', source: 'factory' };
});

describe('FactoryRunProofCard', () => {
  test('a pass shows the commit, the tests, and the failure without the fix as evidence', () => {
    mocks.run = runOf({ regressionProof: proofOf({}) });
    render(<FactoryRunProofCard threadId="t1" />);
    const card = screen.getByTestId('factory-run-proof-card');
    expect(screen.getByTestId('factory-run-proof-verdict')).toHaveTextContent('Passed');
    expect(card).toHaveTextContent('ea34890');
    expect(screen.getByTestId('factory-run-proof-summary')).toHaveTextContent(
      'fail without the fix',
    );
    expect(screen.getByTestId('factory-run-proof-files')).toHaveTextContent('PromptInput.test.tsx');

    fireEvent.click(screen.getByTestId('factory-run-proof-details-toggle'));
    expect(screen.getByTestId('factory-run-proof-command')).toHaveTextContent(
      'bun test --parallel',
    );
    expect(screen.getByTestId('factory-run-proof-output')).toHaveTextContent(
      '(fail) keeps image attachments per thread',
    );
  });

  test('a fail shows its finding and the failing output', () => {
    mocks.run = runOf({
      regressionProof: proofOf({
        verdict: 'fail',
        finding: 'The tests pass on the base commit: they do not catch the bug',
        outputTail: ' 28 pass\n 0 fail',
      }),
    });
    render(<FactoryRunProofCard threadId="t1" />);
    expect(screen.getByTestId('factory-run-proof-verdict')).toHaveTextContent('Failed');
    expect(screen.getByTestId('factory-run-proof-finding')).toHaveTextContent(
      'they do not catch the bug',
    );
    expect(screen.queryByTestId('factory-run-proof-summary')).toBeNull();
    fireEvent.click(screen.getByTestId('factory-run-proof-details-toggle'));
    expect(screen.getByTestId('factory-run-proof-output')).toHaveTextContent('28 pass');
  });

  test('a skipped proof says why, with no tests or output to show', () => {
    mocks.run = runOf({
      regressionProof: proofOf({
        verdict: 'skipped',
        finding: 'No test files changed',
        files: [],
        commands: [],
        outputTail: '',
      }),
    });
    render(<FactoryRunProofCard threadId="t1" />);
    expect(screen.getByTestId('factory-run-proof-verdict')).toHaveTextContent('Skipped');
    expect(screen.getByTestId('factory-run-proof-finding')).toHaveTextContent(
      'No test files changed',
    );
    expect(screen.queryByTestId('factory-run-proof-files')).toBeNull();
    expect(screen.queryByTestId('factory-run-proof-details-toggle')).toBeNull();
  });

  test('nothing before a proof ran, or for a thread that is not a factory run', () => {
    const { rerender } = render(<FactoryRunProofCard threadId="t1" />);
    expect(screen.queryByTestId('factory-run-proof-card')).toBeNull();

    mocks.run = runOf({ regressionProof: proofOf({}) });
    mocks.thread = { id: 't1', projectId: 'p1', source: 'web' };
    rerender(<FactoryRunProofCard threadId="t1" />);
    expect(screen.queryByTestId('factory-run-proof-card')).toBeNull();
  });
});

describe('the "no change" outcome', () => {
  test('a run that ended with no change is not an error: it points to the explanation on the issue', () => {
    mocks.run = runOf({ state: 'no_change', currentStep: 'pull-request', failureReason: null });
    render(<FactoryRunFailureCard threadId="t1" agentRunning={false} />);
    const card = screen.getByTestId('factory-run-no-change-card');
    expect(card).toHaveTextContent('The agent made no change');
    expect(card).toHaveTextContent('posted on issue #209');
    expect(card).toHaveTextContent('marked for triage');
    expect(screen.queryByTestId('factory-run-failure-card')).toBeNull();
    // The member may disagree with the agent.
    expect(screen.getByTestId('factory-run-failure-retry')).toBeInTheDocument();
  });

  test('a run that committed nothing but left unsaved work says the checkout was kept', () => {
    mocks.run = runOf({
      state: 'waiting_human',
      currentStep: 'pull-request',
      failureReason: 'no change',
    });
    render(<FactoryRunFailureCard threadId="t1" agentRunning={false} />);
    const card = screen.getByTestId('factory-run-no-change-card');
    expect(card).toHaveTextContent('left unsaved work in its checkout');
    expect(screen.queryByTestId('factory-run-failure-card')).toBeNull();
    expect(screen.getByTestId('factory-run-failure-retry')).toBeInTheDocument();
  });
});

describe('the "regression proof not configured" blocker', () => {
  test('a queued issue whose flow has no proof rules says so in the factory view', () => {
    mocks.queue = [
      {
        ...runOf({
          id: 'r2',
          issueNumber: 12,
          state: 'requested',
          threadIds: [],
          queueOrder: 1,
          waitReason: { kind: 'proof-not-configured', blockers: [] },
        }),
        projectId: 'p1',
      },
    ];
    // The view's search bar and status pins carry tooltips.
    render(
      <MemoryRouter>
        <TooltipProvider>
          <FactoryQueueView />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('factory-view-run-r2')).toHaveTextContent(
      'Regression proof not configured',
    );
  });
});
