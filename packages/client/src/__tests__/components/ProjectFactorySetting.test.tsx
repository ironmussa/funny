import { beforeEach, describe, expect, test, vi, type Mock, mock } from 'bun:test';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';
import { MemoryRouter } from 'react-router-dom';

import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryRun, FactorySettings } from '@/lib/api/factory';

interface FactoryMocks {
  settings: FactorySettings | null;
  save: Mock<(...args: any[]) => any>;
  runs: FactoryRun[];
  control: Mock<(...args: any[]) => any>;
  empty: Mock<(...args: any[]) => any>;
  toastError: Mock<(...args: any[]) => any>;
  canSteer: boolean;
  /** Whether the flow's review step resolves to the implementer's provider and model. */
  sameReviewer: boolean | undefined;
}

const mocks = ((): FactoryMocks => ({
  settings: null,
  save: vi.fn(),
  runs: [],
  control: vi.fn(),
  empty: vi.fn(),
  toastError: vi.fn(),
  canSteer: true,
  sameReviewer: undefined,
}))();

mock.module('@/data/projects/hooks', () => ({ useCanSteerProject: () => mocks.canSteer }));

mock.module('@/data/factory/hooks', () => ({
  useFactorySettings: () => mocks.settings,
  useFactoryRuns: () => mocks.runs,
  useFactoryFlowDefinition: (_projectId: string, name: string) => ({
    definition: {
      name,
      source: 'built-in',
      path: null,
      yaml: '',
      reviewerSameAsImplementer: mocks.sameReviewer,
    },
    error: null,
  }),
}));
mock.module('@/data/factory/actions', () => ({
  saveFactorySettings: (input: unknown) => mocks.save(input),
  controlFactoryRun: (...args: unknown[]) => mocks.control(...args),
  emptyFactory: (...args: unknown[]) => mocks.empty(...args),
}));
mock.module('@/lib/toast-error', () => ({ toastError: mocks.toastError }));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string, vars?: Record<string, unknown>) =>
      (fallback ?? _k).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars?.[name] ?? '')),
  }),
}));

import { ProjectFactorySetting } from '@/components/general-settings-project/ProjectFactorySetting';

const configured = (over: Partial<FactorySettings> = {}): FactorySettings => ({
  projectId: 'p1',
  enabled: true,
  // The label rows below are automatic mode's.
  mode: 'automatic',
  label: 'ready-for-agent',
  flowName: 'issue-to-merge',
  maxConcurrent: 2,
  autoMerge: 'low_risk',
  sensitivePaths: [],
  stageLimits: {},
  blockedReason: null,
  updatedAt: '2026-11-16T00:00:00.000Z',
  ...over,
});

const pressed = (v: string) =>
  screen.getByTestId(`settings-factory-${v}`).getAttribute('aria-pressed');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = null;
  mocks.canSteer = true;
  mocks.sameReviewer = undefined;
  mocks.runs = [];
  mocks.control.mockImplementation(() => okAsync({}));
  mocks.empty.mockImplementation(() => okAsync({ cleared: 0, stopped: 0 }));
  mocks.save.mockImplementation((input: Record<string, unknown>) =>
    okAsync({ ...configured(), ...input }),
  );
});

describe('ProjectFactorySetting', () => {
  test('hidden from a caller who cannot start threads on the project (a viewer)', () => {
    mocks.canSteer = false;
    mocks.settings = configured();
    render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.queryByTestId('settings-factory-on')).toBeNull();
  });

  test('is its own settings section, headed "Issue factory"', () => {
    render(<ProjectFactorySetting projectId="p1" />);
    const section = screen.getByTestId('settings-factory-section');
    expect(section.querySelector('h3')).toHaveTextContent('Issue factory');
    expect(section).toContainElement(screen.getByTestId('settings-factory-on'));
  });

  test('off by default, with no detail rows', () => {
    render(<ProjectFactorySetting projectId="p1" />);
    expect(pressed('off')).toBe('true');
    expect(screen.queryByTestId('settings-factory-label')).toBeNull();
  });

  test('turning it on saves enabled', () => {
    render(<ProjectFactorySetting projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-factory-on'));
    expect(mocks.save).toHaveBeenCalledWith({ projectId: 'p1', enabled: true });
  });

  test('enabled shows the detail rows with their values', () => {
    mocks.settings = configured({ label: 'bug', maxConcurrent: 4 });
    render(<ProjectFactorySetting projectId="p1" />);
    expect(pressed('on')).toBe('true');
    expect(screen.getByTestId('settings-factory-label')).toHaveValue('bug');
    expect(screen.getByTestId('settings-factory-concurrency')).toHaveValue(4);
  });

  test('editing the label saves it, carrying the enabled flag', () => {
    mocks.settings = configured();
    render(<ProjectFactorySetting projectId="p1" />);
    const input = screen.getByTestId('settings-factory-label');
    fireEvent.blur(input, { target: { value: 'needs-agent' } });
    expect(mocks.save).toHaveBeenCalledWith({
      projectId: 'p1',
      enabled: true,
      label: 'needs-agent',
    });
  });

  test('an out-of-range concurrency is not saved', () => {
    mocks.settings = configured();
    render(<ProjectFactorySetting projectId="p1" />);
    fireEvent.blur(screen.getByTestId('settings-factory-concurrency'), { target: { value: '99' } });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  test('a refused save shows the error and puts the saved value back in the input', async () => {
    mocks.settings = configured({ label: 'ready-for-agent' });
    mocks.save.mockImplementation(() =>
      errAsync({ type: 'FORBIDDEN', message: 'Running an issue factory needs contributor access' }),
    );
    render(<ProjectFactorySetting projectId="p1" />);
    const input = screen.getByTestId('settings-factory-label');
    fireEvent.change(input, { target: { value: 'rejected' } });
    fireEvent.blur(input);

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId('settings-factory-label')).toHaveValue('ready-for-agent'),
    );
  });
});

const runOf = (over: Partial<FactoryRun>): FactoryRun =>
  buildFactoryRun({
    id: 'r1',
    issueNumber: 7,
    state: 'working',
    currentStep: 'implement',
    threadIds: ['t1'],
    startedAt: '2026-11-16T00:00:00.000Z',
    completedAt: null,
    flowName: null,
    ...over,
  });

const renderRuns = () =>
  render(
    <MemoryRouter>
      <ProjectFactorySetting projectId="p1" />
    </MemoryRouter>,
  );

describe('factory blocked reason', () => {
  test('why the factory cannot make progress is shown, and nothing when it can', () => {
    mocks.settings = configured({ blockedReason: 'Waiting for your runner' });
    const { unmount } = render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.getByTestId('settings-factory-blocked')).toHaveTextContent(
      'Waiting for your runner',
    );
    unmount();
    mocks.settings = configured();
    render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.queryByTestId('settings-factory-blocked')).toBeNull();
  });
});

// Change factory-agent-roles: how the factory reviews and merges.
describe('review and merge settings', () => {
  const blur = (testId: string, value: string) =>
    fireEvent.blur(screen.getByTestId(testId), { target: { value } });

  test('hidden while the factory is paused, shown with their values when it runs', () => {
    mocks.settings = configured({ enabled: false });
    const { unmount } = render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.queryByTestId('settings-factory-automerge-low')).toBeNull();
    unmount();

    mocks.settings = configured({
      autoMerge: 'all',
      sensitivePaths: ['billing/**', 'infra/**'],
      stageLimits: { review: 1 },
    });
    render(<ProjectFactorySetting projectId="p1" />);
    expect(pressed('automerge-all')).toBe('true');
    expect(screen.getByTestId('settings-factory-sensitive-paths')).toHaveValue(
      'billing/**, infra/**',
    );
    expect(screen.getByTestId('settings-factory-limit-review')).toHaveValue(1);
    expect(screen.getByTestId('settings-factory-limit-implement')).toHaveValue(null);
  });

  test('choosing what merges by itself saves it', () => {
    mocks.settings = configured();
    render(<ProjectFactorySetting projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-factory-automerge-all'));
    expect(mocks.save).toHaveBeenCalledWith({ projectId: 'p1', enabled: true, autoMerge: 'all' });
  });

  test('sensitive paths are saved as a list, and an unchanged list is not saved', () => {
    mocks.settings = configured({ sensitivePaths: ['billing/**'] });
    render(<ProjectFactorySetting projectId="p1" />);
    blur('settings-factory-sensitive-paths', ' billing/** ');
    expect(mocks.save).not.toHaveBeenCalled();
    blur('settings-factory-sensitive-paths', 'billing/**, infra/**,, billing/**');
    expect(mocks.save).toHaveBeenCalledWith({
      projectId: 'p1',
      enabled: true,
      sensitivePaths: ['billing/**', 'infra/**'],
    });
  });

  test('a stage limit is saved with the other limits; emptying it removes it', () => {
    mocks.settings = configured({ stageLimits: { implement: 3 } });
    render(<ProjectFactorySetting projectId="p1" />);
    blur('settings-factory-limit-review', '1');
    expect(mocks.save).toHaveBeenCalledWith({
      projectId: 'p1',
      enabled: true,
      stageLimits: { implement: 3, review: 1 },
    });
    mocks.save.mockClear();
    blur('settings-factory-limit-implement', '');
    expect(mocks.save).toHaveBeenCalledWith({ projectId: 'p1', enabled: true, stageLimits: {} });
  });

  test('an out-of-range or unchanged stage limit is not saved, and merge has no input', () => {
    mocks.settings = configured({ stageLimits: { review: 2 } });
    render(<ProjectFactorySetting projectId="p1" />);
    blur('settings-factory-limit-review', '0');
    blur('settings-factory-limit-review', '99');
    blur('settings-factory-limit-review', '2');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.queryByTestId('settings-factory-limit-merge')).toBeNull();
  });

  test('a reviewer on the same model as the implementer is called out; a different one is not', () => {
    mocks.settings = configured();
    mocks.sameReviewer = true;
    const { unmount } = render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.getByTestId('settings-factory-same-reviewer')).toHaveTextContent(
      'same provider and model',
    );
    unmount();

    mocks.sameReviewer = false;
    render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.queryByTestId('settings-factory-same-reviewer')).toBeNull();
  });
});

describe('factory runs', () => {
  test('a run in flight can be stopped; its thread is linked', () => {
    mocks.settings = configured();
    mocks.runs = [runOf({})];
    renderRuns();
    expect(screen.getByTestId('factory-run-thread-r1')).toHaveAttribute(
      'href',
      '/projects/p1/threads/t1',
    );
    expect(screen.queryByTestId('factory-run-retry-r1')).toBeNull();
    fireEvent.click(screen.getByTestId('factory-run-stop-r1'));
    expect(mocks.control).toHaveBeenCalledWith('stop', 'p1', 'r1');
  });

  test('a run waiting for the member is called out and can be retried or stopped', () => {
    mocks.settings = configured({ enabled: false });
    mocks.runs = [
      runOf({ state: 'waiting_human', currentStep: 'ci', prUrl: 'https://github.com/o/r/pull/9' }),
    ];
    renderRuns();
    expect(screen.getByTestId('factory-runs-waiting')).toHaveTextContent('1 waiting for you');
    expect(screen.getByTestId('factory-run-pr-r1')).toHaveAttribute(
      'href',
      'https://github.com/o/r/pull/9',
    );
    fireEvent.click(screen.getByTestId('factory-run-retry-r1'));
    expect(mocks.control).toHaveBeenCalledWith('retry', 'p1', 'r1');
    expect(screen.getByTestId('factory-run-stop-r1')).toBeInTheDocument();
  });

  test('an ended run has no controls, and a refused one shows the error', async () => {
    mocks.settings = configured();
    mocks.runs = [runOf({ id: 'r2', state: 'merged' }), runOf({ state: 'failed' })];
    mocks.control.mockImplementation(() => errAsync({ type: 'CONFLICT', message: 'nope' }));
    renderRuns();
    expect(screen.queryByTestId('factory-run-stop-r2')).toBeNull();
    expect(screen.queryByTestId('factory-run-retry-r2')).toBeNull();
    fireEvent.click(screen.getByTestId('factory-run-retry-r1'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
  });
  test('manual mode hides the label; switching the mode saves it with the enabled flag', () => {
    mocks.settings = configured({ mode: 'manual' });
    render(<ProjectFactorySetting projectId="p1" />);
    expect(pressed('mode-manual')).toBe('true');
    expect(screen.queryByTestId('settings-factory-label')).toBeNull();

    fireEvent.click(screen.getByTestId('settings-factory-mode-automatic'));
    expect(mocks.save).toHaveBeenCalledWith({ projectId: 'p1', enabled: true, mode: 'automatic' });
  });

  test('queued issues come first with why they wait, and the queue can be cleared', () => {
    mocks.settings = configured();
    mocks.runs = [
      runOf({ id: 'w', issueNumber: 5 }),
      runOf({
        id: 'q2',
        issueNumber: 3,
        state: 'requested',
        currentStep: null,
        queueOrder: 2,
        waitReason: { kind: 'blocker-not-sent', blockers: [9] },
      }),
      runOf({ id: 'q1', issueNumber: 4, state: 'requested', currentStep: null, queueOrder: 1 }),
    ];
    renderRuns();

    const rows = screen.getAllByTestId(/^factory-run-(w|q1|q2)$/).map((el) => el.dataset.testid);
    expect(rows).toEqual(['factory-run-q1', 'factory-run-q2', 'factory-run-w']);
    expect(screen.getByTestId('factory-run-wait-q2')).toHaveTextContent(
      'Blocked by #9, which is not in the factory',
    );

    fireEvent.click(screen.getByTestId('factory-clear-queue'));
    expect(mocks.empty).toHaveBeenCalledWith('clear-queue', 'p1');
  });

  test('stop all asks for a confirmation first', () => {
    mocks.settings = configured();
    mocks.runs = [runOf({ id: 'w' })];
    renderRuns();

    fireEvent.click(screen.getByTestId('factory-stop-all'));
    expect(mocks.empty).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(mocks.empty).toHaveBeenCalledWith('stop-all', 'p1');
  });

  test('the mode can change while the factory is paused, keeping it paused', () => {
    mocks.settings = configured({ enabled: false, mode: 'automatic' });
    render(<ProjectFactorySetting projectId="p1" />);

    fireEvent.click(screen.getByTestId('settings-factory-mode-manual'));

    expect(mocks.save).toHaveBeenCalledWith({ projectId: 'p1', enabled: false, mode: 'manual' });
  });

  // Change factory-agent-roles: why a run is not merged shows in its row.
  test('a run held at the merge shows its review, its risk and the reason', () => {
    mocks.settings = configured();
    mocks.runs = [
      runOf({
        state: 'waiting_human',
        currentStep: 'merge',
        failureReason: 'high risk',
        reviews: [
          {
            sha: 'a'.repeat(40),
            verdict: 'pass',
            findings: [],
            reviewedAt: '2026-11-22T00:00:00Z',
          },
        ],
        risk: { headSha: 'a'.repeat(40), level: 'high', reasons: ['touches .github/'] },
      }),
    ];
    renderRuns();
    expect(screen.getByTestId('factory-run-review-r1')).toHaveTextContent('Review passed');
    expect(screen.getByTestId('factory-run-risk-r1')).toHaveAttribute('title', 'touches .github/');
    expect(screen.getByTestId('factory-run-reason-r1')).toHaveTextContent(
      'Not merged: high risk, it needs you',
    );
  });

  test('a failed review is shown as failed, and a run in the lane says so', () => {
    mocks.settings = configured();
    mocks.runs = [
      runOf({
        state: 'merging',
        currentStep: 'merge',
        reviews: [
          {
            sha: 'a'.repeat(40),
            verdict: 'fail',
            findings: [{ severity: 'high', title: 'Wrong' }],
            reviewedAt: '2026-11-22T00:00:00Z',
          },
        ],
      }),
    ];
    renderRuns();
    expect(screen.getByTestId('factory-run-review-r1')).toHaveTextContent('Review failed');
    expect(screen.getByTestId('factory-run-r1')).toHaveTextContent('In the merge lane');
    expect(screen.queryByTestId('factory-run-reason-r1')).toBeNull();
  });

  // Change factory-agent-roles, phase 2: triage in the run's row.
  test('a run parked on its issue says so and can be retried; its contract shows when it has one', () => {
    mocks.settings = configured();
    mocks.runs = [
      runOf({
        state: 'needs_info',
        failureReason: 'needs info',
        triage: { decision: 'needs_info', at: '2026-11-22T00:00:00Z', items: ['Which endpoint?'] },
      }),
    ];
    const { unmount } = renderRuns();
    expect(screen.getByTestId('factory-run-r1')).toHaveTextContent('Needs info');
    expect(screen.getByTestId('factory-run-reason-r1')).toHaveTextContent('Asked on the issue');
    expect(screen.queryByTestId('factory-run-contract-r1')).toBeNull();
    fireEvent.click(screen.getByTestId('factory-run-retry-r1'));
    expect(mocks.control).toHaveBeenCalledWith('retry', 'p1', 'r1');
    unmount();

    mocks.runs = [
      runOf({
        triage: {
          decision: 'ready',
          at: '2026-11-22T00:00:00Z',
          contract: {
            acceptanceCriteria: ['Negative numbers are summed'],
            likelyPaths: [],
            riskHints: [],
          },
        },
      }),
    ];
    renderRuns();
    expect(screen.getByTestId('factory-run-contract-r1')).toHaveAttribute(
      'title',
      'Negative numbers are summed',
    );
  });

  test('a run that went on without a contract shows "No contract"', () => {
    mocks.settings = configured();
    mocks.runs = [runOf({ triage: { decision: 'none', at: '2026-11-22T00:00:00Z' } })];
    renderRuns();
    expect(screen.getByTestId('factory-run-contract-r1')).toHaveTextContent('No contract');
  });
});
