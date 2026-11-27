import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';

import type { FactorySettings } from '@/lib/api/factory';

// The issue factory's lanes (openspec factory-lanes): a lane is a label on the
// issue, so choosing one in the send dialog labels the issues before the send.

const addLabels = vi.fn();
const send = vi.fn();
const toastWarning = vi.fn();
mock.module('@/lib/api', () => ({ api: { githubAddIssueLabels: addLabels } }));
mock.module('@/data/factory/hooks', () => ({
  useFactoryFlows: () => [{ name: 'issue-to-merge', source: 'built-in' }],
  useFactoryBlockers: () => [],
  useFactoryLanes: () => [
    {
      id: 'l1',
      name: 'payments',
      label: 'lane:payments',
      branch: 'lane/payments',
      baseBranch: 'develop',
      finishBranch: null,
      state: 'active',
    },
    { id: 'l2', name: 'old', label: 'lane:old', branch: 'lane/old', state: 'finished' },
  ],
  useFactorySettings: () => null,
  useFactorySettingsFailed: () => false,
  useFactoryRuns: () => [],
}));
const saveSettings = vi.fn((..._args: unknown[]) => okAsync(null));
mock.module('@/data/factory/actions', () => ({
  saveFactorySettings: (...args: unknown[]) => saveSettings(...args),
  sendIssuesToFactory: (...args: unknown[]) => send(...args),
  controlFactoryRun: vi.fn(),
  retryFactorySettings: vi.fn(),
}));
mock.module('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), warning: toastWarning, error: vi.fn() },
}));
// The branch picker searches the project's branches: a button that picks `qa`, showing its value.
mock.module('@/data/hooks', () => ({ useDataQuery: () => ({ data: undefined }) }));
mock.module('@/components/SearchablePicker', () => ({
  BranchPicker: ({
    selected,
    placeholder,
    onChange,
    testId,
  }: {
    selected: string;
    placeholder?: string;
    onChange: (branch: string) => void;
    testId?: string;
  }) => (
    <button type="button" data-testid={testId} onClick={() => onChange('qa')}>
      {selected || placeholder}
    </button>
  ),
}));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, vars?: Record<string, unknown>) =>
      (typeof fallback === 'string' ? fallback : key).replace(/\{\{(\w+)\}\}/g, (_m, name) =>
        String(vars?.[name] ?? ''),
      ),
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
// Base UI's Select needs layout APIs happy-dom lacks: a native select, under the trigger's test id.
function SelectTrigger(_props: { 'data-testid'?: string; children?: ReactNode }) {
  return null;
}
mock.module('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => {
    const trigger = Children.toArray(children).find(
      (child): child is ReactElement<{ 'data-testid'?: string }> =>
        isValidElement(child) && child.type === SelectTrigger,
    );
    return (
      <select
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        data-testid={trigger?.props['data-testid']}
      >
        {children}
      </select>
    );
  },
  SelectTrigger,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

const { IssuesFactorySendDialog, issuesInOtherLane, laneNameFrom } =
  await import('@/components/issues/IssueFactoryControls');

const settings: FactorySettings = {
  projectId: 'project-1',
  enabled: true,
  mode: 'manual',
  label: 'ready-for-agent',
  flowName: 'issue-to-merge',
  maxConcurrent: 2,
  autoMerge: 'low_risk',
  sensitivePaths: [],
  sizeGateEnabled: false,
  maxLowRiskLines: 400,
  approvalAdjustMaxLines: 0,
  sizeIgnoredPaths: [],
  stageLimits: {},
  stepOverrides: {},
  batch: { size: 5, waitSeconds: 60 },
  dependencies: 'wait',
  tooBig: 'ask',
  specStage: false,
  commitSpecPath: '',
  holdPathsAwaitingApproval: false,
  baseBranch: '',
  laneLabelPrefix: 'lane:',
  laneBranchPrefix: 'lane/',
  laneFinishBranch: '',
  blockedReason: null,
  updatedAt: '2026-11-16T00:00:00.000Z',
};

function renderDialog(
  labels: Record<number, string[]> = {},
  onSent = vi.fn(),
  over: Partial<FactorySettings> = {},
) {
  render(
    <IssuesFactorySendDialog
      open
      onOpenChange={() => {}}
      projectId="project-1"
      settings={{ ...settings, ...over }}
      selected={[1, 2]}
      labelsOf={(n) => labels[n] ?? []}
      onSent={onSent}
    />,
  );
  return onSent;
}

describe('IssuesFactorySendDialog lanes', () => {
  beforeEach(() => {
    addLabels.mockReset();
    send.mockReset();
    saveSettings.mockClear();
    toastWarning.mockReset();
    send.mockImplementation((_p: string, issues: number[]) =>
      okAsync({ accepted: issues, refused: [] }),
    );
  });

  test('offers the active lanes only', () => {
    renderDialog();
    const lane = screen.getByTestId('issues-factory-lane');
    expect(lane).toHaveTextContent('payments');
    expect(lane).not.toHaveTextContent('old');
  });

  test('without a lane the issues are sent as their labels say', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('issues-factory-send'));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('project-1', [1, 2], 'issue-to-merge', undefined),
    );
    expect(addLabels).not.toHaveBeenCalled();
  });

  test('a lane labels the issues first, and an issue GitHub did not label is not sent', async () => {
    addLabels.mockReturnValue(
      okAsync({ labeled: [1], failed: [{ issueNumber: 2, message: '#2: refused' }] }),
    );
    const onSent = renderDialog();
    fireEvent.change(screen.getByTestId('issues-factory-lane'), {
      target: { value: 'payments' },
    });
    expect(screen.getByTestId('issues-factory-lane-hint')).toHaveTextContent('lane/payments');
    fireEvent.click(screen.getByTestId('issues-factory-send'));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('project-1', [1], 'issue-to-merge', undefined),
    );
    expect(addLabels).toHaveBeenCalledWith('project-1', [1, 2], ['lane:payments']);
    expect(toastWarning).toHaveBeenCalledWith(expect.stringContaining('#2: refused'));
    expect(onSent).toHaveBeenCalledWith([1]);
  });

  test('a new lane needs a valid name before the send', () => {
    renderDialog();
    fireEvent.change(screen.getByTestId('issues-factory-lane'), {
      target: { value: '__new__' },
    });
    expect(screen.getByTestId('issues-factory-send')).toBeDisabled();
    fireEvent.change(screen.getByTestId('issues-factory-lane-name'), {
      target: { value: 'bad name' },
    });
    expect(screen.getByTestId('issues-factory-lane-invalid')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('issues-factory-lane-name'), {
      target: { value: 'Billing' },
    });
    expect(screen.getByTestId('issues-factory-send')).toBeEnabled();
    expect(screen.getByTestId('issues-factory-lane-hint')).toHaveTextContent('lane:billing');
  });

  test('without a lane, shows the branch the pull requests merge into', () => {
    renderDialog({}, vi.fn(), { baseBranch: 'qa' });
    expect(screen.getByTestId('issues-factory-route-base')).toHaveTextContent('Merge into');
    expect(screen.getByTestId('issues-factory-route-base')).toHaveTextContent('qa');
    expect(screen.queryByTestId('issues-factory-route-finish')).toBeNull();
  });

  test('without a "Merge into" branch, says the repository default', () => {
    renderDialog();
    expect(screen.getByTestId('issues-factory-route-base')).toHaveTextContent('Repository default');
  });

  test('an existing lane shows the branches it was created with, not pickers', () => {
    renderDialog({}, vi.fn(), { baseBranch: 'master', laneFinishBranch: 'qa' });
    fireEvent.change(screen.getByTestId('issues-factory-lane'), {
      target: { value: 'payments' },
    });
    expect(screen.getByTestId('issues-factory-route-base')).toHaveTextContent('develop');
    expect(screen.getByTestId('issues-factory-route-finish')).toHaveTextContent('qa');
    expect(screen.queryByTestId('issues-factory-route-base-picker')).toBeNull();
    expect(screen.queryByTestId('issues-factory-route-finish-picker')).toBeNull();
  });

  test('a new lane without "Finish into" lands on "Starts from"', () => {
    renderDialog({}, vi.fn(), { baseBranch: 'master' });
    fireEvent.change(screen.getByTestId('issues-factory-lane'), {
      target: { value: '__new__' },
    });
    expect(screen.getByTestId('issues-factory-route-finish')).toHaveTextContent(
      'Same as Starts from',
    );
  });

  test('a branch chosen without a lane goes with the send, not to the settings', async () => {
    renderDialog({}, vi.fn(), { baseBranch: 'master' });
    fireEvent.click(screen.getByTestId('issues-factory-route-base-picker'));
    expect(screen.getByTestId('issues-factory-route-base')).toHaveTextContent('qa');
    fireEvent.click(screen.getByTestId('issues-factory-send'));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('project-1', [1, 2], 'issue-to-merge', {
        baseBranch: 'qa',
      }),
    );
    expect(saveSettings).not.toHaveBeenCalled();
  });

  test('the branches of a new lane go with the send that makes it', async () => {
    addLabels.mockReturnValue(okAsync({ labeled: [1, 2], failed: [] }));
    renderDialog({}, vi.fn(), { baseBranch: 'master' });
    fireEvent.change(screen.getByTestId('issues-factory-lane'), {
      target: { value: '__new__' },
    });
    fireEvent.change(screen.getByTestId('issues-factory-lane-name'), {
      target: { value: 'billing' },
    });
    fireEvent.click(screen.getByTestId('issues-factory-route-finish-picker'));
    fireEvent.click(screen.getByTestId('issues-factory-send'));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('project-1', [1, 2], 'issue-to-merge', {
        lane: { name: 'billing', baseBranch: undefined, finishBranch: 'qa' },
      }),
    );
    expect(saveSettings).not.toHaveBeenCalled();
  });

  test('warns about an issue already in another lane', () => {
    renderDialog({ 2: ['bug', 'Lane:Search'] });
    fireEvent.change(screen.getByTestId('issues-factory-lane'), {
      target: { value: 'payments' },
    });
    expect(screen.getByTestId('issues-factory-lane-conflict')).toHaveTextContent(
      '#2 (Lane:Search)',
    );
  });
});

describe('lane helpers', () => {
  test('laneNameFrom lower-cases a usable name and refuses the rest', () => {
    expect(laneNameFrom(' Payments ')).toBe('payments');
    expect(laneNameFrom('a.b_c-1')).toBe('a.b_c-1');
    expect(laneNameFrom('two words')).toBeNull();
    expect(laneNameFrom('a..b')).toBeNull();
    expect(laneNameFrom('-x')).toBeNull();
    expect(laneNameFrom('')).toBeNull();
  });

  test('issuesInOtherLane ignores the chosen lane and labels without the prefix', () => {
    const labels: Record<number, string[]> = { 1: ['lane:payments'], 2: ['lane:x'], 3: ['bug'] };
    expect(issuesInOtherLane([1, 2, 3], (n) => labels[n] ?? [], 'lane:', 'LANE:payments')).toEqual([
      { issue: 2, label: 'lane:x' },
    ]);
  });
});
