import type { CICheck, PRDetail } from '@funny/shared';
import { fireEvent, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CITab } from '@/components/CITab';
import { createDataLayer } from '@/data/data-layer';
import { seedPR } from '@/data/pull-requests/queries';
import { replaceDataLayer } from '@/data/runtime';
import { sortChecks } from '@/lib/ci-checks';

import { mockT } from '../helpers/mock-i18n';
import { flushAsyncUpdates, renderWithProviders } from '../helpers/render';

const githubPRDetail = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/github', () => ({
  githubApi: { githubPRDetail, githubPRThreads: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

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

describe('sortChecks', () => {
  test('orders failures, then pending, then successes', () => {
    expect(sortChecks(CHECKS).map((c) => c.id)).toEqual([3, 2, 1]);
  });
});

const DETAIL = {
  checks: CHECKS,
  checks_passed: 1,
  checks_failed: 1,
  checks_pending: 1,
  review_decision: null,
  mergeable_state: 'mergeable',
  merged: false,
} as unknown as PRDetail;

describe('CITab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replaceDataLayer(createDataLayer({ userId: null }));
    seedPR('project-1', 51, { detail: DETAIL });
  });

  test('lists cached checks failures first without refetching while fresh', () => {
    renderWithProviders(<CITab projectId="project-1" prNumber={51} visible />);

    const rows = screen.getAllByTestId(/^ci-check-\d+$/);
    expect(rows.map((r) => r.dataset.testid)).toEqual(['ci-check-3', 'ci-check-2', 'ci-check-1']);
    expect(githubPRDetail).not.toHaveBeenCalled();
  });

  test('refresh forces a fetch', async () => {
    githubPRDetail.mockReturnValue(okAsync(DETAIL));
    renderWithProviders(<CITab projectId="project-1" prNumber={51} visible />);

    fireEvent.click(screen.getByTestId('ci-refresh'));
    await flushAsyncUpdates();

    expect(githubPRDetail).toHaveBeenCalledWith('project-1', 51);
  });
});
