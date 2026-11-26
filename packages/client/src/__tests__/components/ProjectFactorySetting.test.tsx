import { beforeEach, describe, expect, test, vi, type Mock, mock } from 'bun:test';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';

import type { FactoryFlowValidation, FactoryReadiness, FactorySettings } from '@/lib/api/factory';

interface FactoryMocks {
  settings: FactorySettings | null;
  save: Mock<(...args: any[]) => any>;
  closeIncident: Mock<(...args: any[]) => any>;
  proposeQueueCi: Mock<(...args: any[]) => any>;
  toastError: Mock<(...args: any[]) => any>;
  canSteer: boolean;
  /** Whether the flow's review step resolves to the implementer's provider and model. */
  sameReviewer: boolean | undefined;
  /** What Validate flow answers once asked. */
  validation: FactoryFlowValidation | undefined;
  /** How the repository merges through the merge queue. */
  readiness: FactoryReadiness | undefined;
}

const mocks = ((): FactoryMocks => ({
  settings: null,
  save: vi.fn(),
  closeIncident: vi.fn(),
  proposeQueueCi: vi.fn(),
  toastError: vi.fn(),
  canSteer: true,
  sameReviewer: undefined,
  validation: undefined,
  readiness: undefined,
}))();

mock.module('@/data/projects/hooks', () => ({ useCanSteerProject: () => mocks.canSteer }));

mock.module('@/data/factory/hooks', () => ({
  useFactoryReadiness: () => mocks.readiness,
  useFactorySettings: () => mocks.settings,
  useFactoryLanes: () => [],
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
  useFactoryFlowValidation: (_projectId: string, _flow: string, requested: boolean) => ({
    validation: requested ? mocks.validation : undefined,
    error: null,
    loading: false,
    refresh: () => {},
  }),
}));
mock.module('@/data/factory/actions', () => ({
  saveFactorySettings: (input: unknown) => mocks.save(input),
  closeFactoryIncident: (...args: unknown[]) => mocks.closeIncident(...args),
  proposeQueueCi: (...args: unknown[]) => mocks.proposeQueueCi(...args),
}));
mock.module('@/lib/toast-error', () => ({ toastError: mocks.toastError }));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string, vars?: Record<string, unknown>) =>
      (fallback ?? _k).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars?.[name] ?? '')),
  }),
}));

import { ProjectFactorySetting } from '@/components/general-settings-project/ProjectFactorySetting';
import { withStepOverride } from '@/components/general-settings-project/ProjectFactoryStepOptions';

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
  laneLabelPrefix: 'feature:',
  laneBranchPrefix: 'feature/',
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
  mocks.validation = undefined;
  mocks.closeIncident.mockImplementation(() => okAsync(configured()));
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

  test('the size gate is off by default and hides its line limit until it is on', () => {
    mocks.settings = configured();
    render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.getByTestId('settings-factory-size-gate')).not.toBeChecked();
    expect(screen.queryByTestId('settings-factory-max-low-risk-lines')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-factory-size-gate'));
    expect(mocks.save).toHaveBeenCalledWith({
      projectId: 'p1',
      enabled: true,
      sizeGateEnabled: true,
    });
  });

  test('the size limit is saved when it is a whole number in range', () => {
    mocks.settings = configured({ sizeGateEnabled: true });
    render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.getByTestId('settings-factory-max-low-risk-lines')).toHaveValue(400);
    blur('settings-factory-max-low-risk-lines', '400');
    blur('settings-factory-max-low-risk-lines', '5');
    blur('settings-factory-max-low-risk-lines', 'abc');
    expect(mocks.save).not.toHaveBeenCalled();
    blur('settings-factory-max-low-risk-lines', '800');
    expect(mocks.save).toHaveBeenCalledWith({
      projectId: 'p1',
      enabled: true,
      maxLowRiskLines: 800,
    });
  });

  // openspec factory-approval-survives-integration, 4.4.
  test('the adjustment an approval follows is off by default and saved within its range', () => {
    mocks.settings = configured();
    render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.getByTestId('settings-factory-approval-adjust-max-lines')).toHaveValue(0);
    blur('settings-factory-approval-adjust-max-lines', '0');
    blur('settings-factory-approval-adjust-max-lines', '201');
    blur('settings-factory-approval-adjust-max-lines', '');
    blur('settings-factory-approval-adjust-max-lines', 'abc');
    expect(mocks.save).not.toHaveBeenCalled();
    blur('settings-factory-approval-adjust-max-lines', '50');
    expect(mocks.save).toHaveBeenCalledWith({
      projectId: 'p1',
      enabled: true,
      approvalAdjustMaxLines: 50,
    });
  });

  test('the globs left out of the size are saved as a list', () => {
    mocks.settings = configured();
    render(<ProjectFactorySetting projectId="p1" />);
    blur('settings-factory-size-ignored-paths', '**/generated/**, , **/generated/**');
    expect(mocks.save).toHaveBeenCalledWith({
      projectId: 'p1',
      enabled: true,
      sizeIgnoredPaths: ['**/generated/**'],
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

  // openspec factory-integration 5.2: stacked pull requests.
  test('choosing to stack on blockers in progress saves it', () => {
    mocks.settings = configured();
    render(<ProjectFactorySetting projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-factory-dependencies-stack'));
    expect(mocks.save).toHaveBeenCalledWith({
      projectId: 'p1',
      enabled: true,
      dependencies: 'stack',
    });
  });

  // openspec factory-integration 6.1: how the repository merges, and why.
  test('a repository that cannot batch says why and what to change', () => {
    mocks.settings = configured();
    mocks.readiness = {
      mode: 'serial',
      queueCi: false,
      mergeQueueRequired: false,
      upToDateRequired: null,
      mergeDriver: null,
      medianCiMs: null,
      batchWaitMs: 60_000,
      reasons: ["CI does not run on the merge queue's branches"],
      advice: [],
    };
    mocks.proposeQueueCi.mockReturnValue(
      okAsync({ issueNumber: 77, url: 'https://github.com/o/r/issues/77', queued: true }),
    );
    render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.getByTestId('settings-factory-readiness-mode')).toHaveTextContent(
      'Pull requests merge one at a time:',
    );
    expect(screen.getByTestId('settings-factory-readiness')).toHaveTextContent(
      "CI does not run on the merge queue's branches",
    );
    expect(screen.getByTestId('settings-factory-readiness-driver')).toHaveTextContent(
      'known after the first integration',
    );
    expect(screen.queryByTestId('settings-factory-readiness-ci-time')).toBeNull();
    // The CI trigger is offered as a factory run, never as an edit made here.
    fireEvent.click(screen.getByTestId('settings-factory-propose-queue-ci'));
    expect(mocks.proposeQueueCi).toHaveBeenCalledWith('p1');
    mocks.readiness = undefined;
  });

  test('a batching repository shows its merge driver, CI time against the wait, and advice', () => {
    mocks.settings = configured();
    mocks.readiness = {
      mode: 'batches',
      queueCi: true,
      mergeQueueRequired: false,
      upToDateRequired: false,
      mergeDriver: 'git',
      medianCiMs: 240_000,
      batchWaitMs: 600_000,
      reasons: [],
      advice: ['install weave'],
    };
    render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.getByTestId('settings-factory-readiness-driver')).toHaveTextContent("git's own");
    expect(screen.getByTestId('settings-factory-readiness-ci-time')).toHaveTextContent(
      'CI on a batch takes 4m 0s (median); the batch wait is 10m 0s',
    );
    expect(screen.getByTestId('settings-factory-readiness-advice')).toHaveTextContent(
      'install weave',
    );
    expect(screen.queryByTestId('settings-factory-propose-queue-ci')).toBeNull();
    mocks.readiness = undefined;
  });

  // openspec factory-integration 4.6: the merge queue's batches.
  test('the batch size and wait are saved together; out of range or unchanged, nothing is saved', () => {
    mocks.settings = configured({ batch: { size: 5, waitSeconds: 60 } });
    render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.getByTestId('settings-factory-batch-size')).toHaveValue(5);
    expect(screen.getByTestId('settings-factory-batch-wait')).toHaveValue(60);
    blur('settings-factory-batch-size', '3');
    expect(mocks.save).toHaveBeenCalledWith({
      projectId: 'p1',
      enabled: true,
      batch: { size: 3, waitSeconds: 60 },
    });
    mocks.save.mockClear();
    blur('settings-factory-batch-wait', '0');
    expect(mocks.save).toHaveBeenCalledWith({
      projectId: 'p1',
      enabled: true,
      batch: { size: 5, waitSeconds: 0 },
    });
    mocks.save.mockClear();
    blur('settings-factory-batch-size', '0');
    blur('settings-factory-batch-size', '11');
    blur('settings-factory-batch-wait', '601');
    blur('settings-factory-batch-wait', '60');
    expect(mocks.save).not.toHaveBeenCalled();
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

// Change factory-agent-roles, D10: a broken base branch pauses the factory.
describe('an incident', () => {
  const incident = (over: Record<string, unknown> = {}) => ({
    id: 'i1',
    repo: 'o/r',
    baseBranch: 'main',
    state: 'reported' as const,
    redSha: 'abc123',
    openedAt: '2026-11-22T12:00:00.000Z',
    closedAt: null,
    candidates: [],
    result: null,
    ...over,
  });

  test('is shown with what the factory found, in place of the plain reason', () => {
    mocks.settings = configured({
      blockedReason: 'Incident: the base branch main of o/r is red',
      incident: incident({
        result: {
          decision: 'revert',
          reason: 'It removed the helper.',
          culpritPrUrl: 'https://github.com/o/r/pull/113',
          revertPrUrl: 'https://github.com/o/r/pull/900',
        },
      }),
    });
    render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.getByTestId('settings-factory-incident')).toHaveTextContent(
      'The base branch main of o/r is red after a factory merge',
    );
    expect(screen.getByTestId('settings-factory-incident-culprit')).toHaveAttribute(
      'href',
      'https://github.com/o/r/pull/113',
    );
    expect(screen.getByTestId('settings-factory-incident-revert')).toHaveAttribute(
      'href',
      'https://github.com/o/r/pull/900',
    );
    expect(screen.queryByTestId('settings-factory-blocked')).toBeNull();
  });

  test('says so while the factory is still looking, and when it could not name a merge', () => {
    mocks.settings = configured({ incident: incident({ state: 'investigating' }) });
    const { unmount } = render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.getByTestId('settings-factory-incident')).toHaveTextContent(
      'looking for the merge that broke it',
    );
    unmount();

    mocks.settings = configured({
      incident: incident({ result: { decision: 'unknown', reason: 'The test is flaky.' } }),
    });
    render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.getByTestId('settings-factory-incident-finding')).toHaveTextContent(
      'could not name the merge that broke it: The test is flaky.',
    );
  });

  test('a member closes it, and a refusal is shown', async () => {
    mocks.settings = configured({ incident: incident() });
    render(<ProjectFactorySetting projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-factory-incident-close'));
    expect(mocks.closeIncident).toHaveBeenCalledWith('p1');

    mocks.closeIncident.mockImplementation(() =>
      errAsync({ type: 'NOT_FOUND', message: 'No incident is open for this factory.' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('settings-factory-incident-close')).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId('settings-factory-incident-close'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
  });

  test('without an incident the plain reason shows as before', () => {
    mocks.settings = configured({ blockedReason: 'The runner is offline', incident: null });
    render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.getByTestId('settings-factory-blocked')).toHaveTextContent(
      'The runner is offline',
    );
    expect(screen.queryByTestId('settings-factory-incident')).toBeNull();
  });
});

describe('factory mode', () => {
  test('manual mode hides the label; switching the mode saves it with the enabled flag', () => {
    mocks.settings = configured({ mode: 'manual' });
    render(<ProjectFactorySetting projectId="p1" />);
    expect(pressed('mode-manual')).toBe('true');
    expect(screen.queryByTestId('settings-factory-label')).toBeNull();

    fireEvent.click(screen.getByTestId('settings-factory-mode-automatic'));
    expect(mocks.save).toHaveBeenCalledWith({ projectId: 'p1', enabled: true, mode: 'automatic' });
  });

  test('the mode can change while the factory is paused, keeping it paused', () => {
    mocks.settings = configured({ enabled: false, mode: 'automatic' });
    render(<ProjectFactorySetting projectId="p1" />);

    fireEvent.click(screen.getByTestId('settings-factory-mode-manual'));

    expect(mocks.save).toHaveBeenCalledWith({ projectId: 'p1', enabled: false, mode: 'manual' });
  });
});

describe('agent step options', () => {
  const agentStep = (stepId: string, over: Record<string, unknown> = {}) => ({
    stepId,
    provider: 'claude',
    model: 'opus',
    effort: null,
    permissionMode: 'autoEdit',
    allowedTools: null,
    disallowedTools: null,
    thread: 'continue' as const,
    overridden: false,
    ...over,
  });

  test('Validate flow shows each problem with its step and field', () => {
    mocks.settings = configured();
    mocks.validation = {
      ok: false,
      message: 'refused',
      problems: [
        { step: 'implement', field: 'permission_mode', message: 'cannot run unattended' },
        { step: 'flow', field: 'flow', message: 'YAML syntax error at line 3' },
      ],
    };
    render(<ProjectFactorySetting projectId="p1" />);
    expect(screen.queryByTestId('settings-factory-problems')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-factory-validate-flow'));
    const problems = screen.getAllByTestId('settings-factory-problem').map((li) => li.textContent);
    expect(problems).toEqual([
      'implement · permission_mode: cannot run unattended',
      'flow: YAML syntax error at line 3',
    ]);
  });

  test('a valid flow lists its agent steps, their options, warnings and unused overrides', () => {
    mocks.settings = configured({ stepOverrides: { review: { model: 'haiku' } } });
    mocks.validation = {
      ok: true,
      name: 'issue-to-merge',
      source: 'repository',
      commit: 'abc1234def',
      steps: [],
      agentSteps: [
        agentStep('implement', { effort: 'high' }),
        agentStep('advise', { thread: 'new', permissionMode: 'plan', provider: 'codex' }),
      ],
      unusedOverrides: ['review'],
      warnings: ['Step ci.before_retry continues the implementing thread on haiku'],
    };
    render(<ProjectFactorySetting projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-factory-validate-flow'));
    expect(screen.getByTestId('settings-factory-flow-source').textContent).toContain('abc1234');
    expect(screen.getByTestId('settings-factory-step-implement-resolved').textContent).toBe(
      'claude · opus · high · autoEdit',
    );
    expect(screen.getByTestId('settings-factory-step-advise-own-thread')).toBeTruthy();
    expect(screen.getByTestId('settings-factory-flow-warning').textContent).toContain('haiku');
    fireEvent.click(screen.getByTestId('settings-factory-unused-review-remove'));
    expect(mocks.save).toHaveBeenCalledWith({ projectId: 'p1', enabled: true, stepOverrides: {} });
  });

  test('withStepOverride sets, clears, and drops a model the new provider lacks', () => {
    expect(withStepOverride({}, 'ci.before_retry', 'model', 'haiku')).toEqual({
      'ci.before_retry': { model: 'haiku' },
    });
    expect(withStepOverride({ a: { model: 'haiku' } }, 'a', 'model', null)).toEqual({});
    expect(
      withStepOverride({ a: { model: 'haiku', effort: 'low' } }, 'a', 'provider', 'codex'),
    ).toEqual({ a: { provider: 'codex', effort: 'low' } });
  });
});
