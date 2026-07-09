import type { PRDetail } from '@funny/shared';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PRSummaryCard } from '@/components/PRSummaryCard';
import { usePRDetailStore } from '@/stores/pr-detail-store';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

vi.mock('@/lib/api/github', () => ({
  githubApi: {
    githubPRDetail: vi.fn(),
    githubPRThreads: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

function makeDetail(overrides: Partial<PRDetail> = {}): PRDetail {
  return {
    number: 51,
    title: 'fix(core): throttle public auth token endpoints',
    body: '',
    state: 'open',
    draft: false,
    merged: false,
    mergeable_state: 'mergeable',
    html_url: 'https://github.com/acme/repo/pull/51',
    additions: 12,
    deletions: 4,
    changed_files: 3,
    commits: 2,
    head: { ref: 'feature/pr-branch', sha: 'abc123' },
    base: { ref: 'qa' },
    user: {
      login: 'argenisleon',
      avatar_url: 'https://example.test/argenis.png',
    },
    review_decision: 'APPROVED',
    checks: [],
    checks_passed: 0,
    checks_failed: 0,
    checks_pending: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z',
    last_commit: {
      sha: 'abc123',
      message: 'fix: handle edge case',
      author: { login: 'alice', avatar_url: 'https://example.test/alice.png' },
      author_name: 'Raw Author',
      date: '2026-01-01T00:01:00.000Z',
    },
    ...overrides,
  };
}

describe('PRSummaryCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:31:00.000Z'));
    usePRDetailStore.getState().clearAll();
    usePRDetailStore.setState({
      detailByKey: { 'project-1:51': makeDetail() },
      lastFetchDetail: { 'project-1:51': Date.now() },
      lastFetchThreads: { 'project-1:51': Date.now() },
    });
  });

  afterEach(() => {
    usePRDetailStore.getState().clearAll();
    vi.useRealTimers();
  });

  test('renders number, title, merge line, updated time, and last commit author', () => {
    renderWithProviders(
      <PRSummaryCard
        projectId="project-1"
        prNumber={51}
        prUrl="https://github.com/acme/repo/pull/51"
        prState="OPEN"
        visible
      />,
    );

    const number = screen.getByTestId('pr-summary-number');
    expect(number).toHaveAttribute('href', 'https://github.com/acme/repo/pull/51');
    expect(number).toHaveTextContent('#51');
    expect(screen.getByTestId('pr-summary-title')).toHaveTextContent(
      'fix(core): throttle public auth token endpoints',
    );

    const mergeLine = screen.getByTestId('pr-summary-merge-info');
    expect(mergeLine).toHaveTextContent('argenisleon wants to merge 2 commits into');
    expect(mergeLine).toHaveTextContent('qa');
    expect(mergeLine).toHaveTextContent('from');
    expect(mergeLine).toHaveTextContent('feature/pr-branch');

    const meta = screen.getByTestId('pr-summary-meta');
    expect(meta).toHaveTextContent('Updated 30m ago');
    expect(meta).toHaveTextContent('Last commit by');
    expect(meta).toHaveTextContent('alice');

    const status = screen.getByTestId('pr-summary-status');
    expect(status).not.toHaveTextContent('Open');
    expect(status).toHaveTextContent('+12');
    expect(status).toHaveTextContent('-4');
    expect(status).toHaveTextContent('3');
    expect(status).toHaveTextContent('Approved');
  });

  test('does not render a redundant merged status badge', () => {
    usePRDetailStore.setState({
      detailByKey: {
        'project-1:51': makeDetail({ state: 'closed', merged: true, mergeable_state: 'unknown' }),
      },
    });

    renderWithProviders(
      <PRSummaryCard
        projectId="project-1"
        prNumber={51}
        prUrl="https://github.com/acme/repo/pull/51"
        prState="MERGED"
        visible
      />,
    );

    expect(screen.getByTestId('pr-summary-number')).toHaveTextContent('#51');
    expect(screen.queryByText('Merged')).not.toBeInTheDocument();
  });
});
