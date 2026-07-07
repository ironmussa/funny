import type { GitHubPR, GitStatusInfo, Thread } from '@funny/shared';
import { screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { PullRequestsTab } from '@/components/PullRequestsTab';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { ThreadProvider } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

const apiMock = vi.hoisted(() => ({
  githubStatus: vi.fn(),
  githubPRFilterOptions: vi.fn(),
  githubPRs: vi.fn(),
  githubPRsSearch: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: apiMock,
}));

vi.mock('@/components/PinnedPRCard', () => ({
  PinnedPRCard: ({ pr }: { pr: GitHubPR }) => <div data-testid={`pinned-pr-${pr.number}`} />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-pr',
    projectId: 'project-1',
    title: 'PR branch thread',
    status: 'completed',
    mode: 'local',
    branch: 'feature/pr-branch',
    baseBranch: 'qa',
    provider: 'codex',
    cost: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  } as Thread;
}

function makeStatus(overrides: Partial<GitStatusInfo> = {}): GitStatusInfo {
  return {
    threadId: 'thread-pr',
    branchKey: 'project-1:feature/pr-branch',
    state: 'pushed',
    dirtyFileCount: 0,
    unpushedCommitCount: 0,
    unpulledCommitCount: 0,
    hasRemoteBranch: true,
    isMergedIntoBase: false,
    linesAdded: 0,
    linesDeleted: 0,
    ...overrides,
  };
}

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

describe('PullRequestsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.githubStatus.mockReturnValue(okAsync({ connected: true, login: 'argenisleon' }));
    apiMock.githubPRFilterOptions.mockReturnValue(okAsync({ labels: [], users: [] }));
    apiMock.githubPRsSearch.mockReturnValue(okAsync({ prs: [], hasMore: false }));

    const thread = makeThread();
    useProjectStore.setState({
      projects: [
        {
          id: 'project-1',
          name: 'goliiive-v2',
          path: '/repo',
          color: '#14b8a6',
          userId: 'user-1',
          sortOrder: 0,
          defaultBranch: 'qa',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      selectedProjectId: 'project-1',
      branchByProject: { 'project-1': 'qa' },
      initialized: true,
    } as any);
    useThreadStore.setState({
      threadDataById: { [thread.id]: thread },
      threadsById: { [thread.id]: thread },
      threadIdsByProject: { 'project-1': [thread.id] },
      selectedThreadId: thread.id,
      activeThread: thread,
    } as any);
    useGitStatusStore.setState({
      statusByBranch: { 'project-1:feature/pr-branch': makeStatus() },
      threadToBranchKey: { [thread.id]: 'project-1:feature/pr-branch' },
      statusByProject: {},
      loadingProjects: new Set(),
      _loadingBranchKeys: new Set(),
      _loadingProjectStatus: new Set(),
    } as any);
  });

  test('syncs the current-branch PR into git status so Activity can show its badge', async () => {
    apiMock.githubPRs.mockReturnValue(
      okAsync({ prs: [makePR()], hasMore: false, owner: 'acme', repo: 'repo' }),
    );

    renderWithProviders(
      <ThreadProvider threadId="thread-pr">
        <PullRequestsTab visible />
      </ThreadProvider>,
    );

    await waitFor(() => {
      expect(
        useGitStatusStore.getState().statusByBranch['project-1:feature/pr-branch']?.prNumber,
      ).toBe(51);
    });
  });

  test('loads open pull requests by default without branch toolbar controls', async () => {
    apiMock.githubPRs.mockReturnValue(
      okAsync({
        prs: [
          makePR(),
          makePR({
            number: 52,
            html_url: 'https://github.com/acme/repo/pull/52',
            head: { ref: 'other-branch', label: 'acme:other-branch' },
            commits: 3,
            last_commit: {
              sha: 'abc123',
              message: 'fix: handle edge case',
              author: { login: 'alice', avatar_url: 'https://example.test/alice.png' },
              author_name: 'Raw Author',
              date: '2026-01-01T00:01:00.000Z',
            },
          }),
        ],
        hasMore: false,
        owner: 'acme',
        repo: 'repo',
      }),
    );

    renderWithProviders(
      <ThreadProvider threadId="thread-pr">
        <PullRequestsTab visible />
      </ThreadProvider>,
    );

    await waitFor(() => {
      expect(apiMock.githubPRs).toHaveBeenCalledWith(
        'project-1',
        expect.objectContaining({ state: 'open' }),
      );
    });
    expect(screen.queryByTestId('prs-toggle-view-all')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prs-branch-focus-indicator')).not.toBeInTheDocument();
    expect(screen.getByTestId('prs-state-trigger')).toHaveTextContent('Open');
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
    expect(screen.getByText('Last commit by')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    const mergeLine = screen.getByTestId('pr-merge-line-52');
    expect(mergeLine).toHaveTextContent('argenisleon wants to merge 3 commits into');
    expect(mergeLine).toHaveTextContent('qa');
    expect(mergeLine).toHaveTextContent('from');
    expect(mergeLine).toHaveTextContent('other-branch');
    expect(screen.getByTestId('pr-diff-link-52')).toHaveAttribute(
      'href',
      'https://github.com/acme/repo/pull/52/files',
    );
  });
});
