import { beforeEach, describe, expect, test, vi, type Mock } from 'bun:test';

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
}

const mocks = ((): FactoryMocks => ({
  settings: null,
  save: vi.fn(),
  runs: [],
  control: vi.fn(),
  empty: vi.fn(),
  toastError: vi.fn(),
  canSteer: true,
}))();

vi.mock('@/data/projects/hooks', () => ({ useCanSteerProject: () => mocks.canSteer }));

vi.mock('@/data/factory/hooks', () => ({
  useFactorySettings: () => mocks.settings,
  useFactoryRuns: () => mocks.runs,
}));
vi.mock('@/data/factory/actions', () => ({
  saveFactorySettings: (input: unknown) => mocks.save(input),
  controlFactoryRun: (...args: unknown[]) => mocks.control(...args),
  emptyFactory: (...args: unknown[]) => mocks.empty(...args),
}));
vi.mock('@/lib/toast-error', () => ({ toastError: mocks.toastError }));
vi.mock('react-i18next', () => ({
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
});
