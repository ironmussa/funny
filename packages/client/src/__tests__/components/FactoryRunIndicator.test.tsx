import { beforeEach, describe, expect, test, vi, type Mock, mock } from 'bun:test';

import { fireEvent, render, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';

import { TooltipProvider } from '@/components/ui/tooltip';
import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryRun } from '@/lib/api/factory';
import { factoryRunSteps } from '@/lib/factory-run-labels';

interface IndicatorMocks {
  run: FactoryRun | null;
  canSteer: boolean;
  control: Mock<(...args: any[]) => any>;
}

const mocks = ((): IndicatorMocks => ({
  run: null,
  canSteer: true,
  control: vi.fn(),
}))();

mock.module('@/data/factory/hooks', () => ({ useFactoryRunForThread: () => mocks.run }));
mock.module('@/data/projects/hooks', () => ({ useCanSteerProject: () => mocks.canSteer }));
mock.module('@/data/factory/actions', () => ({
  approveFactoryMerge: () => okAsync(null),
  setFactoryRunLintCleanup: () => ({ orTee: () => undefined }),
  markFactoryRunDone: () => ({ orTee: () => undefined }),
  controlFactoryRun: (...args: unknown[]) => mocks.control(...args),
}));
mock.module('@/lib/toast-error', () => ({ toastError: vi.fn() }));
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

import { FactoryRunIndicator } from '@/components/thread/FactoryRunIndicator';

const STEPS = ['implement', 'pull-request', 'ci', 'merge'];

const runOf = (over: Partial<FactoryRun> = {}): FactoryRun =>
  buildFactoryRun({
    id: 'r1',
    issueNumber: 235,
    state: 'working',
    currentStep: 'implement',
    threadIds: ['t1'],
    startedAt: '2026-11-19T18:28:20.146Z',
    completedAt: null,
    source: 'manual',
    flowSteps: STEPS,
    ...over,
  });

const statuses = () =>
  STEPS.map((name) => screen.getByTestId(`factory-run-step-${name}`).getAttribute('data-status'));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run = null;
  mocks.canSteer = true;
  mocks.control.mockImplementation(() => okAsync(runOf()));
});

/** Render the footer icon and open its popover. */
function openIndicator() {
  render(<FactoryRunIndicator projectId="p1" threadId="t1" />, { wrapper: TooltipProvider });
  fireEvent.click(screen.getByTestId('factory-run-indicator'));
}

describe('FactoryRunIndicator', () => {
  test('shows nothing for a thread with no factory run', () => {
    render(<FactoryRunIndicator projectId="p1" threadId="t1" />, { wrapper: TooltipProvider });
    expect(screen.queryByTestId('factory-run-indicator')).toBeNull();
  });

  test('spins while the run works, also after its agent finished; not once it failed or parked', () => {
    mocks.run = runOf({ state: 'waiting_ci', currentStep: 'ci' });
    const { unmount } = render(<FactoryRunIndicator projectId="p1" threadId="t1" />, {
      wrapper: TooltipProvider,
    });
    expect(screen.getByTestId('factory-run-indicator-spinner')).toBeInTheDocument();
    unmount();

    for (const state of ['failed', 'waiting_human', 'merged'] as const) {
      mocks.run = runOf({ state });
      const view = render(<FactoryRunIndicator projectId="p1" threadId="t1" />, {
        wrapper: TooltipProvider,
      });
      expect(screen.queryByTestId('factory-run-indicator-spinner')).toBeNull();
      view.unmount();
    }
  });

  test('the icon names the step the run is on; its popover lists every step', () => {
    mocks.run = runOf();
    render(<FactoryRunIndicator projectId="p1" threadId="t1" />, { wrapper: TooltipProvider });
    const icon = screen.getByTestId('factory-run-indicator');
    expect(icon).toHaveTextContent('implement');
    expect(screen.queryByTestId('factory-run-popover')).toBeNull();

    fireEvent.click(icon);
    expect(screen.getByTestId('factory-run-popover')).toHaveTextContent('Factory · #235');
    expect(screen.getByTestId('factory-run-flow')).toHaveTextContent('issue-to-merge');
    expect(statuses()).toEqual(['current', 'pending', 'pending', 'pending']);
    expect(screen.getByTestId('factory-run-stop')).toBeInTheDocument();
    expect(screen.queryByTestId('factory-run-retry')).toBeNull();
  });

  // The incident of issue #343: the run failed at pull-request while the
  // thread kept working, and the thread said nothing about it.
  test('a run that failed names the failed step, says why, and offers a retry', () => {
    mocks.run = runOf({
      state: 'failed',
      currentStep: 'pull-request',
      failureReason:
        'create_pr[pull-request] failed: No open pull request from the branch factory/issue-235-1cca3fa8: the agent did not open one.',
    });
    render(<FactoryRunIndicator projectId="p1" threadId="t1" />, { wrapper: TooltipProvider });
    expect(screen.getByTestId('factory-run-indicator')).toHaveTextContent('pull-request');

    fireEvent.click(screen.getByTestId('factory-run-indicator'));
    expect(statuses()).toEqual(['done', 'failed', 'pending', 'pending']);
    expect(screen.getByTestId('factory-run-failure')).toHaveTextContent('No open pull request');
    expect(screen.queryByTestId('factory-run-stop')).toBeNull();

    fireEvent.click(screen.getByTestId('factory-run-retry'));
    expect(mocks.control).toHaveBeenCalledWith('retry', 'p1', 'r1');
  });

  test('a merged run names its state and links the pull request', () => {
    mocks.run = runOf({
      state: 'merged',
      currentStep: null,
      prUrl: 'https://github.com/o/r/pull/9',
    });
    render(<FactoryRunIndicator projectId="p1" threadId="t1" />, { wrapper: TooltipProvider });
    expect(screen.getByTestId('factory-run-indicator')).toHaveTextContent('Merged');

    fireEvent.click(screen.getByTestId('factory-run-indicator'));
    expect(statuses()).toEqual(['done', 'done', 'done', 'done']);
    expect(screen.getByTestId('factory-run-pr')).toHaveAttribute(
      'href',
      'https://github.com/o/r/pull/9',
    );
  });

  test('a caller who cannot steer the project sees the run but no controls', () => {
    mocks.canSteer = false;
    mocks.run = runOf({ state: 'failed', currentStep: 'pull-request', failureReason: 'x' });
    openIndicator();
    expect(screen.getByTestId('factory-run-popover')).toBeInTheDocument();
    expect(screen.queryByTestId('factory-run-retry')).toBeNull();
  });
});

describe('factoryRunSteps', () => {
  const names = (run: Partial<FactoryRun>) =>
    factoryRunSteps({ ...runOf(), ...run }).map((s) => s.status);

  test('a merged run has done every step', () => {
    expect(names({ state: 'merged', currentStep: null })).toEqual(['done', 'done', 'done', 'done']);
  });

  test('a run parked with its PR ready has done every step', () => {
    expect(names({ state: 'waiting_human', currentStep: null })).toEqual([
      'done',
      'done',
      'done',
      'done',
    ]);
  });

  test('a run parked after a failure shows the failed step', () => {
    expect(names({ state: 'waiting_human', currentStep: 'ci', failureReason: 'red CI' })).toEqual([
      'done',
      'done',
      'failed',
      'pending',
    ]);
  });

  test('a retried run that has not entered a step yet shows them all pending', () => {
    expect(names({ state: 'queued', currentStep: 'retrying' })).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  test('an older run with no recorded steps shows only its current step', () => {
    expect(factoryRunSteps(runOf({ flowSteps: [], currentStep: 'ci' }))).toEqual([
      { name: 'ci', status: 'current' },
    ]);
  });
});
