import type { GitHubPR, PRConversation, PRReviewThread } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from 'sonner';

import '@/i18n/config';
import { useProjectStore } from '@/stores/project-store';
import { ThreadProvider } from '@/stores/thread-context';
import { useThreadStore, type ThreadWithMessages } from '@/stores/thread-store';

import { PullRequestsTab } from './PullRequestsTab';

// ── Mock data ───────────────────────────────────────────────

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600_000).toISOString();

/** Dependabot-style listing, mirroring the real PRs tab. */
const mockPRs: GitHubPR[] = [
  {
    number: 28,
    title:
      'chore(deps-dev): Bump the development-dependencies group across 1 directory with 28 updates',
    state: 'open',
    html_url: 'https://github.com/ironmussa/funny/pull/28',
    user: {
      login: 'dependabot[bot]',
      avatar_url: 'https://avatars.githubusercontent.com/in/29110?v=4',
    },
    created_at: daysAgo(4),
    updated_at: daysAgo(4),
    head: {
      ref: 'dependabot/npm_and_yarn/development-dependencies-40f95f78bd',
      label: 'ironmussa:development-dependencies',
    },
    base: { ref: 'master', label: 'ironmussa:master' },
    draft: false,
    labels: [
      { name: 'dependencies', color: '0366d6' },
      { name: 'javascript', color: 'f1e05a' },
    ],
    merged_at: null,
  },
  {
    number: 24,
    title: 'chore(deps-dev): Bump typescript from 5.9.3 to 6.0.3',
    state: 'open',
    html_url: 'https://github.com/ironmussa/funny/pull/24',
    user: {
      login: 'dependabot[bot]',
      avatar_url: 'https://avatars.githubusercontent.com/in/29110?v=4',
    },
    created_at: daysAgo(5),
    updated_at: daysAgo(5),
    head: { ref: 'dependabot/bun/typescript-6.0.3', label: 'ironmussa:typescript-6.0.3' },
    base: { ref: 'master', label: 'ironmussa:master' },
    draft: false,
    labels: [
      { name: 'dependencies', color: '0366d6' },
      { name: 'javascript', color: 'f1e05a' },
    ],
    merged_at: null,
  },
  {
    number: 19,
    title: 'feat(thread): surface incoming commits without a second manual refresh',
    state: 'open',
    html_url: 'https://github.com/ironmussa/funny/pull/19',
    user: {
      login: 'argenisleon',
      avatar_url: 'https://avatars.githubusercontent.com/u/3957324?v=4',
    },
    created_at: hoursAgo(6),
    updated_at: hoursAgo(2),
    head: { ref: 'feat/incoming-commits', label: 'ironmussa:feat/incoming-commits' },
    base: { ref: 'master', label: 'ironmussa:master' },
    draft: true,
    labels: [{ name: 'enhancement', color: 'a2eeef' }],
    merged_at: null,
  },
];

const mergedPR: GitHubPR = {
  number: 12,
  title: 'refactor: extract git operations into core package',
  state: 'closed',
  html_url: 'https://github.com/ironmussa/funny/pull/12',
  user: { login: 'argenisleon', avatar_url: 'https://avatars.githubusercontent.com/u/3957324?v=4' },
  created_at: daysAgo(8),
  updated_at: daysAgo(7),
  head: { ref: 'refactor/core-git', label: 'ironmussa:refactor/core-git' },
  base: { ref: 'master', label: 'ironmussa:master' },
  draft: false,
  labels: [],
  merged_at: daysAgo(7),
};

/** PR tied to the current feature branch — pinned at the top in branch-focus mode. */
const branchPR: GitHubPR = {
  number: 31,
  title: 'feat(prs): add a Storybook story for the pull-requests tab',
  body: 'Adds open/closed/all, branch-focus, loading, error and empty states for `PullRequestsTab`.',
  state: 'open',
  html_url: 'https://github.com/ironmussa/funny/pull/31',
  user: { login: 'argenisleon', avatar_url: 'https://avatars.githubusercontent.com/u/3957324?v=4' },
  created_at: hoursAgo(3),
  updated_at: hoursAgo(1),
  head: { ref: 'feat/prs-storybook', label: 'ironmussa:feat/prs-storybook' },
  base: { ref: 'master', label: 'ironmussa:master' },
  draft: false,
  labels: [{ name: 'enhancement', color: 'a2eeef' }],
  merged_at: null,
};

const mockReviewThreads: PRReviewThread[] = [
  {
    id: 1,
    node_id: 'PRRT_1',
    path: 'packages/client/src/components/PullRequestsTab.stories.tsx',
    line: 42,
    original_line: 42,
    side: 'RIGHT',
    start_line: null,
    is_resolved: false,
    is_outdated: false,
    comments: [
      {
        id: 101,
        author: 'claude-bot',
        author_avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4',
        body: 'Consider covering the error state too — the retry button has no story.',
        created_at: hoursAgo(2),
        updated_at: hoursAgo(2),
        author_association: 'COLLABORATOR',
      },
    ],
  },
];

const mockConversation: PRConversation = {
  comments: [
    {
      id: 201,
      author: 'argenisleon',
      author_avatar_url: 'https://avatars.githubusercontent.com/u/3957324?v=4',
      author_association: 'OWNER',
      body: 'Mirrored the dependabot listing from the real tab so the story reads true.',
      created_at: hoursAgo(1),
      updated_at: hoursAgo(1),
      html_url: 'https://github.com/ironmussa/funny/pull/31#issuecomment-201',
      reactions: {
        total: 1,
        plus1: 1,
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
};

// ── Fetch mock ──────────────────────────────────────────────

/** Capture real fetch once at module load — before any story can overwrite it. */
const _realFetch = window.fetch.bind(window);

interface MockFetchOptions {
  /** PRs returned by `/github/prs`. */
  prs?: GitHubPR[];
  /** Leave `/github/prs` pending forever — exercises the loading state. */
  hang?: boolean;
  /** Make `/github/prs` fail with this message — exercises the error state. */
  error?: string;
}

function installMockFetch(opts: MockFetchOptions = {}) {
  const { prs = [], hang = false, error } = opts;

  window.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (url.includes('/github/status')) return json({ connected: true, login: 'argenisleon' });

    if (url.includes('/github/prs')) {
      if (hang) return new Promise<Response>(() => {});
      // 400 keeps the circuit breaker out of it (5xx would trip it).
      if (error) return json({ error }, 400);
      return json({ prs, hasMore: false, owner: 'ironmussa', repo: 'funny' });
    }

    // PinnedPRCard (branch-focus mode) loads review threads + conversation.
    if (url.includes('/github/pr-threads')) return json({ threads: mockReviewThreads });
    if (url.includes('/github/pr-conversation')) return json(mockConversation);

    // Catch-all: empty 200 so nothing throws.
    return json({});
  }) as typeof window.fetch;
}

function restoreFetch() {
  window.fetch = _realFetch;
}

// ── Store seeders ───────────────────────────────────────────

const PROJECT_ID = 'proj-1';

/**
 * Seed a project on `master` (default branch). With no active thread the tab
 * shows the full listing + Open/Closed/All filter — the screenshot case.
 */
function seedProject(currentBranch = 'master') {
  useProjectStore.setState({
    projects: [
      {
        id: PROJECT_ID,
        name: 'funny',
        path: '/home/user/projects/funny',
        color: '#3b82f6',
        userId: 'user-1',
        sortOrder: 0,
        defaultBranch: 'master',
        createdAt: new Date().toISOString(),
      },
    ],
    expandedProjects: new Set([PROJECT_ID]),
    selectedProjectId: PROJECT_ID,
    initialized: true,
    branchByProject: { [PROJECT_ID]: currentBranch },
  });
  useThreadStore.setState({
    threadDataById: {},
    selectedThreadId: null,
    activeThread: null,
  });
}

/**
 * Seed an active thread on a feature branch — drives branch-focus mode, which
 * pins the matching PR (via `PinnedPRCard`) and shows the branch indicator.
 */
function seedThreadOnBranch(branch: string) {
  seedProject('master');
  const thread = {
    id: 'thread-1',
    projectId: PROJECT_ID,
    userId: 'user-1',
    title: 'add pull-requests story',
    mode: 'local',
    status: 'completed',
    stage: 'done',
    provider: 'claude',
    permissionMode: 'autoEdit',
    model: 'sonnet',
    branch,
    baseBranch: 'master',
    runtime: 'local',
    source: 'web',
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
    messages: [],
  } as unknown as ThreadWithMessages;
  useThreadStore.setState({
    threadDataById: { [thread.id]: thread },
    selectedThreadId: thread.id,
    activeThread: thread,
  });
}

// ── Wrapper ─────────────────────────────────────────────────

const EMPTY_MOCK_OPTS: MockFetchOptions = {};

function PullRequestsTabWrapper({
  threadId = null,
  mockFetchOpts = EMPTY_MOCK_OPTS,
}: {
  threadId?: string | null;
  mockFetchOpts?: MockFetchOptions;
}) {
  // Install the mock synchronously BEFORE first render so the tab's mount
  // effect hits the mock instead of the real network.
  installMockFetch(mockFetchOpts);

  useEffect(() => {
    return () => restoreFetch();
  }, [mockFetchOpts]);

  return (
    <MemoryRouter>
      <Toaster />
      <div
        className="bg-sidebar fixed top-0 right-0 flex flex-col"
        style={{ width: 400, height: '100vh', overflow: 'hidden' }}
      >
        <ThreadProvider threadId={threadId}>
          <PullRequestsTab visible />
        </ThreadProvider>
      </div>
    </MemoryRouter>
  );
}

// ── Meta ────────────────────────────────────────────────────

const meta = {
  title: 'Components/PullRequestsTab',
  component: PullRequestsTab,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof PullRequestsTab>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Stories ─────────────────────────────────────────────────

/** Open pull requests on the default branch — the Open/Closed/All listing. */
export const OpenList: Story = {
  name: 'Open List',
  render: () => {
    seedProject('master');
    return <PullRequestsTabWrapper mockFetchOpts={{ prs: mockPRs }} />;
  },
};

/** The full listing including a merged PR (as seen under the "All" filter). */
export const WithMerged: Story = {
  name: 'With Merged PR',
  render: () => {
    seedProject('master');
    return <PullRequestsTabWrapper mockFetchOpts={{ prs: [...mockPRs, mergedPR] }} />;
  },
};

/** No open pull requests. */
export const Empty: Story = {
  render: () => {
    seedProject('master');
    return <PullRequestsTabWrapper mockFetchOpts={{ prs: [] }} />;
  },
};

/** Initial load — spinner while `/github/prs` is in flight. */
export const Loading: Story = {
  render: () => {
    seedProject('master');
    return <PullRequestsTabWrapper mockFetchOpts={{ hang: true }} />;
  },
};

/** Fetch failed — error message with a retry button. */
export const ErrorState: Story = {
  name: 'Error',
  render: () => {
    seedProject('master');
    return <PullRequestsTabWrapper mockFetchOpts={{ error: 'gh: not authenticated' }} />;
  },
};

/**
 * On a feature branch with a matching PR — branch-focus mode pins the PR at the
 * top (review threads + conversation) instead of showing the flat list.
 */
export const BranchFocus: Story = {
  name: 'Branch Focus (PR pinned)',
  render: () => {
    seedThreadOnBranch('feat/prs-storybook');
    return (
      <PullRequestsTabWrapper threadId="thread-1" mockFetchOpts={{ prs: [branchPR, ...mockPRs] }} />
    );
  },
};

/** On a feature branch with no PR yet — branch-focus empty state + escape hatch. */
export const BranchFocusEmpty: Story = {
  name: 'Branch Focus (no PR)',
  render: () => {
    seedThreadOnBranch('feat/orphan-branch');
    return <PullRequestsTabWrapper threadId="thread-1" mockFetchOpts={{ prs: mockPRs }} />;
  },
};

/** No project selected — prompts the user to pick one. */
export const NoProject: Story = {
  name: 'No Project',
  render: () => {
    useProjectStore.setState({
      projects: [],
      selectedProjectId: null,
      initialized: true,
      branchByProject: {},
    });
    useThreadStore.setState({ threadDataById: {}, selectedThreadId: null, activeThread: null });
    return <PullRequestsTabWrapper />;
  },
};
