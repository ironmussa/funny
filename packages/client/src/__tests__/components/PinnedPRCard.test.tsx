import type { GitHubPR } from '@funny/shared';
import { screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { PinnedPRCard } from '@/components/PinnedPRCard';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

const apiMock = vi.hoisted(() => ({
  githubPRThreads: vi.fn(),
  githubPRConversation: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: apiMock,
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

describe('PinnedPRCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.githubPRThreads.mockReturnValue(okAsync({ threads: [] }));
    apiMock.githubPRConversation.mockReturnValue(okAsync({ comments: [], reviews: [] }));
  });

  test('shows the pull request updated time in the header', async () => {
    renderWithProviders(
      <PinnedPRCard
        pr={makePR({
          last_commit: {
            sha: 'abc123',
            message: 'fix: handle edge case',
            author: { login: 'alice', avatar_url: 'https://example.test/alice.png' },
            author_name: 'Raw Author',
            date: '2026-01-01T00:01:00.000Z',
          },
        })}
        projectId="project-1"
      />,
    );

    expect(screen.getByText(/Updated/)).toBeInTheDocument();
    expect(screen.getByText('Last commit by')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();

    await waitFor(() => {
      expect(apiMock.githubPRThreads).toHaveBeenCalledWith('project-1', 51);
    });
  });

  test('falls back to the raw git author when the commit is not linked to GitHub', () => {
    renderWithProviders(
      <PinnedPRCard
        pr={makePR({
          last_commit: {
            sha: 'def456',
            message: 'docs: update readme',
            author: null,
            author_name: 'Unlinked Author',
            date: '2026-01-01T00:01:00.000Z',
          },
        })}
        projectId="project-1"
      />,
    );

    expect(screen.getByText('Last commit by')).toBeInTheDocument();
    expect(screen.getByText('Unlinked Author')).toBeInTheDocument();
  });

  test('shows the merge summary and diff link in the header', () => {
    renderWithProviders(<PinnedPRCard pr={makePR()} projectId="project-1" />);

    const mergeLine = screen.getByTestId('pinned-pr-merge-line-51');
    expect(mergeLine).toHaveTextContent('argenisleon wants to merge 2 commits into');
    expect(mergeLine).toHaveTextContent('qa');
    expect(mergeLine).toHaveTextContent('from');
    expect(mergeLine).toHaveTextContent('feature/pr-branch');
    expect(screen.getByTestId('pr-diff-link-51')).toHaveAttribute(
      'href',
      'https://github.com/acme/repo/pull/51/files',
    );
  });
});
