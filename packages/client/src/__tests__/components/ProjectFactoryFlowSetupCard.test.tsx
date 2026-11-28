import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { FactoryFlowSetupView } from '@funny/shared/contracts/factory';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';

const mocks = {
  setup: null as FactoryFlowSetupView | null,
  confirmFlowSetup: mock(),
  openFlowSetupPR: mock(),
  discardFlowSetup: mock(),
};

mock.module('@/data/factory/hooks', () => ({
  useFactoryFlowSetup: () => mocks.setup,
}));

mock.module('@/data/factory/actions', () => ({
  confirmFactoryFlowSetup: (...args: unknown[]) => mocks.confirmFlowSetup(...args),
  openFactoryFlowSetupPR: (...args: unknown[]) => mocks.openFlowSetupPR(...args),
  discardFactoryFlowSetup: (...args: unknown[]) => mocks.discardFlowSetup(...args),
}));

import { ProjectFactoryFlowSetupCard } from '@/components/general-settings-project/ProjectFactoryFlowSetupCard';

function makeSetup(overrides: Partial<FactoryFlowSetupView> = {}): FactoryFlowSetupView {
  return {
    id: 'setup-1',
    projectId: 'p1',
    flowName: 'issue-to-merge',
    defaultBranch: 'main',
    baseSha: 'abc1234',
    threadId: 't-setup-1',
    branch: 'funny/factory-setup/setup-1',
    state: 'generating',
    startingFile:
      'name: issue-to-merge\nnodes:\n  - id: proof\n    regression_proof:\n      rules: []',
    startingSource: 'builtin',
    builtinPrompts: [],
    proposedFile:
      'name: issue-to-merge\nnodes:\n  - id: proof\n    regression_proof:\n      rules:\n        - globs: ["**/*.test.ts"]\n          command: "bun test {{files}}"',
    proposedFileSha: 'sha-123',
    commitVariant: null,
    facts: {
      packageManager: 'bun',
      recognized: true,
      packages: [
        {
          name: 'app',
          dir: 'packages/app',
          runner: 'bun',
          configFiles: [],
          testPatterns: ['**/*.test.ts'],
        },
      ],
    },
    verdicts: {
      rules: [
        {
          ruleIndex: 0,
          globs: ['**/*.test.ts'],
          command: 'bun test {{files}}',
          accepted: true,
          passingCanary: {
            command: 'bun test pass.test.ts',
            files: ['pass.test.ts'],
            exitCode: 0,
            timedOut: false,
            aborted: false,
            output: 'pass.test.ts ok',
          },
          failingCanary: {
            command: 'bun test fail.test.ts',
            files: ['fail.test.ts'],
            exitCode: 1,
            timedOut: false,
            aborted: false,
            output: 'fail.test.ts expect(1).toBe(2)',
          },
          existingTest: {
            command: 'bun test math.test.ts',
            files: ['math.test.ts'],
            exitCode: 0,
            timedOut: false,
            aborted: false,
            output: 'math.test.ts ok',
          },
        },
      ],
      uncovered: [{ scope: '**/*.integration.test.ts', reason: 'Needs Postgres' }],
      timedOut: false,
    },
    error: null,
    commitSha: null,
    prNumber: null,
    prUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    ...overrides,
  };
}

describe('ProjectFactoryFlowSetupCard (Task 5.1)', () => {
  beforeEach(() => {
    mocks.setup = null;
    mocks.confirmFlowSetup.mockReset().mockReturnValue(okAsync(makeSetup({ state: 'committed' })));
    mocks.openFlowSetupPR.mockReset().mockReturnValue(okAsync(makeSetup({ state: 'pr_open' })));
    mocks.discardFlowSetup.mockReset().mockReturnValue(okAsync(makeSetup({ state: 'discarded' })));
  });

  test('renders generating state with link to setup thread', () => {
    mocks.setup = makeSetup({ state: 'generating' });
    render(<ProjectFactoryFlowSetupCard projectId="p1" flowName="issue-to-merge" />);

    expect(screen.getByTestId('factory-setup-generating')).toBeTruthy();
    const link = screen.getByTestId('factory-setup-thread-link');
    expect(link.getAttribute('href')).toBe('/projects/p1/threads/t-setup-1');
  });

  test('renders verifying state', () => {
    mocks.setup = makeSetup({ state: 'verifying' });
    render(<ProjectFactoryFlowSetupCard projectId="p1" flowName="issue-to-merge" />);
    expect(screen.getByTestId('factory-setup-verifying')).toBeTruthy();
  });

  test('renders proposed state with diff, facts, rule verdicts, uncovered list, and actions', async () => {
    mocks.setup = makeSetup({ state: 'proposed' });
    render(<ProjectFactoryFlowSetupCard projectId="p1" flowName="issue-to-merge" />);

    expect(screen.getByTestId('factory-setup-facts').textContent).toContain('bun');
    expect(screen.getByTestId('factory-setup-diff').textContent).toContain('bun test {{files}}');
    expect(screen.getByTestId('factory-setup-rule-0').textContent).toContain('pass.test.ts ok');
    expect(screen.getByTestId('factory-setup-rule-0').textContent).toContain(
      'fail.test.ts expect(1).toBe(2)',
    );
    expect(screen.getByTestId('factory-setup-rule-0').textContent).toContain('math.test.ts ok');
    expect(screen.getByTestId('factory-setup-uncovered').textContent).toContain('Needs Postgres');

    await act(async () => {
      fireEvent.click(screen.getByTestId('factory-setup-commit'));
    });
    expect(mocks.confirmFlowSetup).toHaveBeenCalledWith('p1', 'setup-1', 'sha-123', 'rules');

    await act(async () => {
      fireEvent.click(screen.getByTestId('factory-setup-opt-out'));
    });
    expect(mocks.confirmFlowSetup).toHaveBeenCalledWith('p1', 'setup-1', 'sha-123', 'opt-out');

    await act(async () => {
      fireEvent.click(screen.getByTestId('factory-setup-discard'));
    });
    expect(mocks.discardFlowSetup).toHaveBeenCalledWith('p1', 'setup-1');
  });

  test('renders failed state with outputs and opt-out control', async () => {
    mocks.setup = makeSetup({
      state: 'failed',
      error: 'No generated regression proof rule passed verification.',
    });
    render(<ProjectFactoryFlowSetupCard projectId="p1" flowName="issue-to-merge" />);

    expect(screen.getByTestId('factory-setup-error').textContent).toContain(
      'No generated regression proof rule passed',
    );
    expect(screen.getByTestId('factory-setup-verdicts')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('factory-setup-opt-out'));
    });
    expect(mocks.confirmFlowSetup).toHaveBeenCalledWith('p1', 'setup-1', 'sha-123', 'opt-out');
  });

  test('renders push_rejected state with GitHub reason and Open a pull request button', async () => {
    mocks.setup = makeSetup({
      state: 'push_rejected',
      error: 'GH006: Protected branch update failed',
    });
    render(<ProjectFactoryFlowSetupCard projectId="p1" flowName="issue-to-merge" />);

    expect(screen.getByTestId('factory-setup-push-rejected-reason').textContent).toContain('GH006');
    await act(async () => {
      fireEvent.click(screen.getByTestId('factory-setup-open-pr'));
    });
    expect(mocks.openFlowSetupPR).toHaveBeenCalledWith('p1', 'setup-1');
  });

  test('renders pr_open state with pull request link', () => {
    mocks.setup = makeSetup({
      state: 'pr_open',
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
    });
    render(<ProjectFactoryFlowSetupCard projectId="p1" flowName="issue-to-merge" />);

    const link = screen.getByTestId('factory-setup-pr-link');
    expect(link.getAttribute('href')).toBe('https://github.com/org/repo/pull/42');
  });
});
