import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import type { GitHubPR, GitStatusInfo, PRDetail, Thread, ThreadWithMessages } from '@funny/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { expectInstance } from '../helpers/builders-components';
import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

const apiMock = (() => ({
  githubStatus: vi.fn(),
  projectGetRemoteUrl: vi.fn(),
  githubPRFilterOptions: vi.fn(),
  githubPRs: vi.fn(),
  githubPRsSearch: vi.fn(),
}))();
const githubApiMock = (() => ({
  githubPRDetail: vi.fn(),
}))();

const logError = (() => vi.fn())();
mock.module('@/lib/client-logger', () => ({
  isClientLogLevelEnabled: () => false,
  createClientLogger: () => ({ error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
mock.module('@/lib/api', () => ({
  api: apiMock,
}));
mock.module('@/lib/api/github', () => ({
  githubApi: githubApiMock,
}));

mock.module('@/components/PinnedPRCard', () => ({
  PinnedPRCard: ({ pr }: { pr: GitHubPR }) => <div data-testid={`pinned-pr-${pr.number}`} />,
}));

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const { PullRequestsTab } = await import('@/components/PullRequestsTab');
const { createDataLayer } = await import('@/data/data-layer');
const { readGitStatusMaps } = await import('@/data/git-status/read');
const { seedGitStatus } = await import('@/data/git-status/testing');
const { seedProjectCurrentBranches, withProjects } = await import('@/data/projects/testing');
const { replaceDataLayer } = await import('@/data/runtime');
const { buildThreadWithMessages, withThreadIndex } = await import('@/data/threads/testing');
const { useProjectStore } = await import('@/stores/project-store');
const { ThreadProvider } = await import('@/stores/thread-context');
const { useThreadStore } = await import('@/stores/thread-store');

function makeThread(overrides: Partial<Thread> = {}): ThreadWithMessages {
  return buildThreadWithMessages({
    id: 'thread-pr',
    projectId: 'project-1',
    title: 'PR branch thread',
    branch: 'feature/pr-branch',
    baseBranch: 'qa',
    provider: 'codex',
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  });
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

describe('PullRequestsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.projectGetRemoteUrl.mockReturnValue(
      okAsync({ remoteUrl: 'https://github.com/acme/repo' }),
    );
    replaceDataLayer(createDataLayer({ userId: null }));
    apiMock.githubStatus.mockReturnValue(okAsync({ connected: true, login: 'argenisleon' }));
    apiMock.githubPRFilterOptions.mockReturnValue(okAsync({ labels: [], users: [] }));
    apiMock.githubPRsSearch.mockReturnValue(okAsync({ prs: [], hasMore: false }));
    githubApiMock.githubPRDetail.mockImplementation((_projectId: string, prNumber: number) =>
      okAsync(
        makeDetail({
          number: prNumber,
          html_url: `https://github.com/acme/repo/pull/${prNumber}`,
          head: {
            ref: prNumber === 52 ? 'other-branch' : 'feature/pr-branch',
            sha: 'abc123',
          },
        }),
      ),
    );

    const thread = makeThread();
    seedProjectCurrentBranches({ 'project-1': 'qa' });
    useProjectStore.setState(
      withProjects({
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
        initialized: true,
      }),
    );
    useThreadStore.setState(
      withThreadIndex({
        threadDataById: { [thread.id]: thread },
        threadsById: { [thread.id]: thread },
        threadIdsByProject: { 'project-1': [thread.id] },
        selectedThreadId: thread.id,
        activeThread: thread,
      }),
    );
    seedGitStatus({
      statusByBranch: { 'project-1:feature/pr-branch': makeStatus() },
      threadToBranchKey: { [thread.id]: 'project-1:feature/pr-branch' },
      statusByProject: {},
    });
  });

  test('does not log a request cancelled on unmount', async () => {
    apiMock.projectGetRemoteUrl.mockReturnValue(
      okAsync({ remoteUrl: 'https://github.com/acme/repo' }),
    );
    let reject!: (error: Error) => void;
    const pending = ResultAsync.fromPromise(
      new Promise<never>((_resolve, fail) => {
        reject = fail;
      }),
      () => ({ message: 'Request aborted' }),
    );
    apiMock.githubPRs.mockReturnValue(pending);
    const view = renderWithProviders(<PullRequestsTab visible />);
    await waitFor(() => expect(apiMock.githubPRs).toHaveBeenCalled());
    const signal = expectInstance(apiMock.githubPRs.mock.calls[0][2], AbortSignal);
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      reject(new Error('Request aborted'));
      await pending;
    });
    expect(logError).not.toHaveBeenCalled();
  });

  test('still logs a real request failure', async () => {
    apiMock.projectGetRemoteUrl.mockReturnValue(
      okAsync({ remoteUrl: 'https://github.com/acme/repo' }),
    );
    apiMock.githubPRs.mockReturnValue(errAsync({ message: 'Runner unavailable' }));
    renderWithProviders(<PullRequestsTab visible />);
    await waitFor(() =>
      expect(logError).toHaveBeenCalledWith(
        'failed to load pull requests',
        expect.objectContaining({ error: 'Runner unavailable' }),
      ),
    );
  });

  test('skips GitHub queries without a remote and recovers after checking again', async () => {
    apiMock.projectGetRemoteUrl.mockReturnValueOnce(okAsync({ remoteUrl: null }));
    apiMock.githubPRs.mockReturnValue(
      okAsync({ prs: [], hasMore: false, owner: 'acme', repo: 'repo' }),
    );
    const view = renderWithProviders(<PullRequestsTab visible />);
    expect(await screen.findByTestId('github-remote-unavailable')).toBeInTheDocument();
    expect(apiMock.githubPRs).not.toHaveBeenCalled();
    expect(apiMock.githubPRFilterOptions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(apiMock.githubPRs).toHaveBeenCalled());
    const signal = expectInstance(apiMock.githubPRs.mock.calls[0][2], AbortSignal);
    view.unmount();
    expect(signal.aborted).toBe(true);
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
      expect(readGitStatusMaps().statusByBranch['project-1:feature/pr-branch']?.prNumber).toBe(51);
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
            commits: undefined,
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
        expect.any(AbortSignal),
      );
    });
    expect(screen.queryByTestId('prs-toggle-view-all')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prs-branch-focus-indicator')).not.toBeInTheDocument();
    expect(screen.getByTestId('prs-state-trigger')).toHaveTextContent('Open');
    // The list renders when the query resolves, after the request is made.
    expect((await screen.findAllByText(/Updated/)).length).toBeGreaterThan(0);
    expect(screen.getByText('Last commit by')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    const mergeLine = screen.getByTestId('pr-merge-line-52');
    expect(mergeLine).toHaveTextContent('argenisleon wants to merge 2 commits into');
    expect(mergeLine).toHaveTextContent('qa');
    expect(mergeLine).toHaveTextContent('from');
    expect(mergeLine).toHaveTextContent('other-branch');
    expect(screen.getByTestId('pr-meta-52')).toHaveTextContent('Updated');
    await waitFor(() => {
      expect(screen.getByTestId('pr-status-52')).toHaveTextContent('+103');
    });
    expect(screen.getByTestId('pr-status-52')).toHaveTextContent('-37');
    expect(screen.getByTestId('pr-status-52')).toHaveTextContent('2');
    expect(screen.getByTestId('pr-status-52')).toHaveTextContent('Ready to merge');
    expect(screen.queryByTestId('pr-diff-link-52')).not.toBeInTheDocument();
  });
});
