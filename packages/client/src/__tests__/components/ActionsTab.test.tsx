import type { ActionJob, ActionRun, CICheck, PRDetail } from '@funny/shared';
import { fireEvent, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ActionsTab } from '@/components/ActionsTab';
import { createDataLayer } from '@/data/data-layer';
import { seedPR } from '@/data/pull-requests/queries';
import { replaceDataLayer } from '@/data/runtime';
import { sortChecks } from '@/lib/ci-checks';
import {
  canRerunFailed,
  formatActionDuration,
  repoActionsUrl,
  runDurationMs,
} from '@/lib/github-actions';

import { mockT } from '../helpers/mock-i18n';
import { flushAsyncUpdates, renderWithProviders } from '../helpers/render';

const api = vi.hoisted(() => ({
  githubPRDetail: vi.fn(),
  githubActionRuns: vi.fn(),
  githubActionJobs: vi.fn(),
  githubActionJobLog: vi.fn(),
  githubRerunFailedJobs: vi.fn(),
}));

vi.mock('@/lib/api/github', () => ({
  githubApi: { ...api, githubPRThreads: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function check(id: number, status: string, conclusion: string | null): CICheck {
  return {
    id,
    name: `check-${id}`,
    status,
    conclusion,
    html_url: null,
    started_at: null,
    completed_at: null,
    app_name: null,
  } as CICheck;
}

const CHECKS = [
  check(1, 'completed', 'success'),
  check(2, 'in_progress', null),
  check(3, 'completed', 'failure'),
];

const DETAIL = {
  checks: CHECKS,
  checks_passed: 1,
  checks_failed: 1,
  checks_pending: 1,
  review_decision: null,
  mergeable_state: 'mergeable',
  merged: false,
} as unknown as PRDetail;

function run(id: number, overrides: Partial<ActionRun> = {}): ActionRun {
  return {
    id,
    name: 'CI',
    display_title: `run ${id}`,
    run_number: id,
    run_attempt: 1,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'feat/x',
    head_sha: 'abcdef1234',
    html_url: `https://github.com/acme/repo/actions/runs/${id}`,
    actor: null,
    created_at: '2026-11-19T10:00:00Z',
    run_started_at: '2026-11-19T10:00:00Z',
    updated_at: '2026-11-19T10:03:04Z',
    ...overrides,
  };
}

const FAILED_JOB: ActionJob = {
  id: 70,
  name: 'test',
  status: 'completed',
  conclusion: 'failure',
  html_url: null,
  started_at: '2026-11-19T10:00:00Z',
  completed_at: '2026-11-19T10:01:00Z',
  steps: [
    {
      number: 1,
      name: 'Set up job',
      status: 'completed',
      conclusion: 'success',
      started_at: null,
      completed_at: null,
    },
    {
      number: 2,
      name: 'Run tests',
      status: 'completed',
      conclusion: 'failure',
      started_at: null,
      completed_at: null,
    },
  ],
};

const RUNS = [run(1), run(2, { conclusion: 'failure' })];

function renderTab(props: Partial<Parameters<typeof ActionsTab>[0]> = {}) {
  return renderWithProviders(
    <ActionsTab projectId="project-1" currentBranch="feat/x" visible {...props} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  replaceDataLayer(createDataLayer({ userId: null }));
  api.githubActionRuns.mockReturnValue(okAsync({ runs: RUNS, total_count: 2, hasMore: false }));
  api.githubActionJobs.mockReturnValue(okAsync({ jobs: [FAILED_JOB] }));
  api.githubActionJobLog.mockReturnValue(
    okAsync({ lines: ['boom', '\x1b[31mError: exit 1\x1b[0m'], truncated: false }),
  );
  api.githubRerunFailedJobs.mockReturnValue(okAsync({ ok: true }));
});

describe('ActionsTab', () => {
  test("lists the current branch's runs, then every branch's", async () => {
    renderTab();
    await flushAsyncUpdates();

    expect(api.githubActionRuns).toHaveBeenCalledWith('project-1', { branch: 'feat/x' });
    expect(screen.getByTestId('actions-run-1')).toBeTruthy();
    expect(screen.getByTestId('actions-run-2')).toBeTruthy();

    fireEvent.click(screen.getByTestId('actions-scope-all'));
    await flushAsyncUpdates();

    expect(api.githubActionRuns).toHaveBeenLastCalledWith('project-1', { branch: null });
  });

  test('without a branch it lists every branch', async () => {
    renderTab({ currentBranch: undefined });
    await flushAsyncUpdates();
    expect(api.githubActionRuns).toHaveBeenCalledWith('project-1', { branch: null });
  });

  test('offers a re-run only on a failed run, and not to a read-only viewer', async () => {
    const { unmount } = renderTab();
    await flushAsyncUpdates();
    expect(screen.queryByTestId('actions-run-rerun-1')).toBeNull();

    fireEvent.click(screen.getByTestId('actions-run-rerun-2'));
    await flushAsyncUpdates();
    expect(api.githubRerunFailedJobs).toHaveBeenCalledWith('project-1', 2);
    unmount();

    renderTab({ readOnly: true });
    await flushAsyncUpdates();
    expect(screen.queryByTestId('actions-run-rerun-2')).toBeNull();
  });

  test("expanding a run shows its jobs, the failed step and the job's log", async () => {
    renderTab();
    await flushAsyncUpdates();

    fireEvent.click(screen.getByTestId('actions-run-toggle-2'));
    await flushAsyncUpdates();

    expect(api.githubActionJobs).toHaveBeenCalledWith('project-1', 2);
    expect(screen.getByTestId('actions-job-70-failed-step-2').textContent).toContain('Run tests');
    expect(screen.queryByTestId('actions-job-70-failed-step-1')).toBeNull();

    fireEvent.click(screen.getByTestId('actions-job-log-toggle-70'));
    await flushAsyncUpdates();

    expect(api.githubActionJobLog).toHaveBeenCalledWith('project-1', 70);
    const log = screen.getByTestId('actions-job-log-70');
    expect(log.textContent).toContain('Error: exit 1');
    // ANSI colors are rendered, not shown as raw escapes.
    expect(log.innerHTML).not.toContain('\x1b');
  });

  test("shows the PR's check summary and opens its checks failures first", () => {
    seedPR('project-1', 51, { detail: DETAIL });
    renderTab({ prNumber: 51 });

    expect(screen.getByTestId('ci-summary-counts')).toBeTruthy();
    fireEvent.click(screen.getByTestId('actions-pr-checks-toggle'));

    const rows = screen.getAllByTestId(/^ci-check-\d+$/);
    expect(rows.map((r) => r.dataset.testid)).toEqual(['ci-check-3', 'ci-check-2', 'ci-check-1']);
  });
});

describe('sortChecks', () => {
  test('orders failures, then pending, then successes', () => {
    expect(sortChecks(CHECKS).map((c) => c.id)).toEqual([3, 2, 1]);
  });
});

describe('github-actions helpers', () => {
  test('formats durations', () => {
    expect(formatActionDuration(5_000)).toBe('5s');
    expect(formatActionDuration(184_000)).toBe('3m 4s');
    expect(formatActionDuration(3_720_000)).toBe('1h 2m');
  });

  test('a finished run lasts until its last update; a running one until now', () => {
    expect(runDurationMs(run(1))).toBe(184_000);
    const now = Date.parse('2026-11-19T10:00:10Z');
    expect(runDurationMs(run(1, { status: 'in_progress', conclusion: null }), now)).toBe(10_000);
  });

  test("derives the repository's Actions page from a run", () => {
    expect(repoActionsUrl(RUNS)).toBe('https://github.com/acme/repo/actions');
    expect(repoActionsUrl([])).toBeNull();
  });

  test('re-runs only finished failed runs', () => {
    expect(canRerunFailed(run(1, { conclusion: 'failure' }))).toBe(true);
    expect(canRerunFailed(run(1, { conclusion: 'startup_failure' }))).toBe(true);
    expect(canRerunFailed(run(1, { conclusion: 'cancelled' }))).toBe(false);
    expect(canRerunFailed(run(1, { status: 'in_progress', conclusion: null }))).toBe(false);
  });
});
