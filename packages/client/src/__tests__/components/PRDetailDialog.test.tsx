import type { GitHubPR, PRDetail } from '@funny/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { PRDetailDialog } from '@/components/PRDetailDialog';
import { usePRDetailStore } from '@/stores/pr-detail-store';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

const apiMock = vi.hoisted(() => ({
  githubPRFiles: vi.fn(),
  githubPRCommits: vi.fn(),
  githubPRFileContent: vi.fn(),
  githubPRThreads: vi.fn(),
  githubPRConversation: vi.fn(),
}));
const githubApiMock = vi.hoisted(() => ({
  githubPRDetail: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: apiMock,
}));
vi.mock('@/lib/api/github', () => ({
  githubApi: githubApiMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

function makePR(overrides: Partial<GitHubPR> = {}): GitHubPR {
  return {
    number: 51,
    title: 'fix(core): throttle public auth token endpoints',
    body: null,
    state: 'open',
    html_url: 'https://github.com/acme/repo/pull/51',
    user: {
      login: 'argenisleon',
      avatar_url: 'https://example.test/avatar.png',
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z',
    head: { ref: 'feature/pr-branch', label: 'acme:feature/pr-branch' },
    base: { ref: 'qa', label: 'acme:qa' },
    commits: 2,
    draft: false,
    labels: [],
    merged_at: null,
    ...overrides,
  };
}

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
    additions: 103,
    deletions: 37,
    changed_files: 2,
    commits: 2,
    head: { ref: 'feature/pr-branch', sha: 'abc123' },
    base: { ref: 'qa' },
    user: {
      login: 'argenisleon',
      avatar_url: 'https://example.test/avatar.png',
    },
    review_decision: null,
    checks: [],
    checks_passed: 0,
    checks_failed: 0,
    checks_pending: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

describe('PRDetailDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePRDetailStore.getState().clearAll();
    apiMock.githubPRFiles.mockReturnValue(okAsync({ files: [] }));
    apiMock.githubPRCommits.mockReturnValue(okAsync({ commits: [] }));
    apiMock.githubPRThreads.mockReturnValue(okAsync({ threads: [] }));
    githubApiMock.githubPRDetail.mockReturnValue(okAsync(makeDetail()));
    apiMock.githubPRConversation.mockReturnValue(
      okAsync({
        comments: [
          {
            id: 101,
            author: 'alice',
            author_avatar_url: 'https://example.test/alice.png',
            author_association: 'MEMBER',
            body: 'Can we verify this path?',
            created_at: '2026-01-01T00:01:00.000Z',
            updated_at: '2026-01-01T00:01:00.000Z',
            html_url: 'https://github.com/acme/repo/pull/51#issuecomment-101',
            reactions: {
              total: 0,
              plus1: 0,
              minus1: 0,
              laugh: 0,
              hooray: 0,
              confused: 0,
              heart: 0,
              rocket: 0,
              eyes: 0,
            },
          },
        ],
        reviews: [],
      }),
    );
  });

  test('shows PR info and conversation as separate tabs', async () => {
    renderWithProviders(
      <PRDetailDialog
        open
        onOpenChange={vi.fn()}
        projectId="project-1"
        pr={makePR()}
        currentUserLogin="argenisleon"
      />,
    );

    expect(screen.getByTestId('pr-detail-badge')).toHaveTextContent('#51');
    expect(screen.getByTestId('pr-detail-title')).toHaveTextContent(
      'fix(core): throttle public auth token endpoints',
    );
    expect(screen.getByTestId('pr-detail-merge-line')).toHaveTextContent(
      'argenisleon wants to merge 2 commits into',
    );
    expect(screen.queryByText('Open')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('pr-detail-status')).toHaveTextContent('+103');
    });
    expect(screen.getByTestId('pr-detail-status')).toHaveTextContent('-37');
    expect(screen.getByTestId('pr-detail-status')).toHaveTextContent('2');
    expect(screen.getByTestId('pr-detail-status')).toHaveTextContent('Ready to merge');
    expect(screen.getByTestId('pr-detail-tab-info')).toHaveAttribute('data-state', 'active');
    expect(screen.getByTestId('pr-detail-commit-select')).toBeInTheDocument();
    expect(screen.getByTestId('pr-detail-tab-conversation')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pr-detail-tab-conversation'));

    await waitFor(() => {
      expect(apiMock.githubPRConversation).toHaveBeenCalledWith('project-1', 51);
    });
    expect(screen.getByTestId('pinned-pr-card-51')).toBeInTheDocument();
    expect(screen.getByTestId('pinned-pr-link-51')).not.toBeVisible();
    expect(await screen.findByText('Can we verify this path?')).toBeInTheDocument();
  });
});
