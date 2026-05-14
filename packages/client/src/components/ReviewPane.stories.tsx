import type { FileDiffSummary, DiffSummaryResponse, GitStatusInfo } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from 'sonner';

import '@/i18n/config';
import { useCommitProgressStore } from '@/stores/commit-progress-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useReviewPaneStore } from '@/stores/review-pane-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { ReviewPane } from './ReviewPane';

// ── Mock data ───────────────────────────────────────────────

const mockFiles: FileDiffSummary[] = [
  {
    path: 'packages/client/src/components/ReviewPane.tsx',
    status: 'modified',
    staged: false,
    additions: 42,
    deletions: 18,
  },
  {
    path: 'packages/client/src/components/FileTree.tsx',
    status: 'added',
    staged: false,
    additions: 310,
    deletions: 0,
  },
  {
    path: 'packages/client/src/components/tool-cards/ExpandedDiffDialog.tsx',
    status: 'modified',
    staged: true,
    additions: 15,
    deletions: 120,
  },
  {
    path: 'packages/client/src/components/DiffStats.tsx',
    status: 'modified',
    staged: true,
    additions: 3,
    deletions: 1,
  },
  {
    path: 'packages/server/src/routes/projects.ts',
    status: 'modified',
    staged: false,
    additions: 22,
    deletions: 5,
  },
  {
    path: 'packages/server/src/services/project-repository.ts',
    status: 'modified',
    staged: false,
    additions: 8,
    deletions: 3,
  },
  {
    path: 'packages/shared/src/types.ts',
    status: 'modified',
    staged: false,
    additions: 6,
    deletions: 0,
  },
  { path: '.gitignore', status: 'modified', staged: false, additions: 1, deletions: 0 },
  { path: 'README.md', status: 'deleted', staged: false, additions: 0, deletions: 45 },
  {
    path: 'packages/client/src/hooks/use-ws.ts',
    status: 'renamed',
    staged: false,
    additions: 10,
    deletions: 2,
  },
];

const mockDiffSummaryResponse: DiffSummaryResponse = {
  files: mockFiles,
  total: mockFiles.length,
  truncated: false,
};

const emptyDiffSummaryResponse: DiffSummaryResponse = {
  files: [],
  total: 0,
  truncated: false,
};

const mockDiff = `--- a/packages/client/src/components/ReviewPane.tsx
+++ b/packages/client/src/components/ReviewPane.tsx
@@ -1,10 +1,12 @@
 import { useState, useEffect } from 'react';
+import { useVirtualizer } from '@tanstack/react-virtual';

 export function ReviewPane() {
-  const [files, setFiles] = useState([]);
+  const [files, setFiles] = useState<FileDiffSummary[]>([]);
+  const [loading, setLoading] = useState(false);

   useEffect(() => {
-    fetchFiles();
+    refresh();
   }, []);

   return (`;

function makeGitStatus(overrides: Partial<GitStatusInfo> = {}): GitStatusInfo {
  return {
    threadId: 'thread-1',
    branchKey: 'proj-1:feat/review-pane',
    state: 'dirty',
    dirtyFileCount: mockFiles.length,
    unpushedCommitCount: 0,
    unpulledCommitCount: 0,
    hasRemoteBranch: true,
    isMergedIntoBase: false,
    linesAdded: 417,
    linesDeleted: 194,
    ...overrides,
  };
}

// ── Fetch mock ──────────────────────────────────────────────

/** Capture real fetch once at module load — before any story can overwrite it. */
const _realFetch = window.fetch.bind(window);

// ── Mock data for History tab ──

const mockLogEntries = [
  {
    hash: 'abc1234567890',
    shortHash: 'abc1234',
    author: 'Argenis Leon',
    relativeDate: '2 hours ago',
    message: 'feat: add file tree component with collapsible folders',
  },
  {
    hash: 'def2345678901',
    shortHash: 'def2345',
    author: 'Argenis Leon',
    relativeDate: '3 hours ago',
    message: 'fix: correct diff stats calculation for renamed files',
  },
  {
    hash: 'ghi3456789012',
    shortHash: 'ghi3456',
    author: 'Argenis Leon',
    relativeDate: '5 hours ago',
    message: 'refactor: extract ReviewPane toolbar into separate component',
  },
  {
    hash: 'jkl4567890123',
    shortHash: 'jkl4567',
    author: 'Claude',
    relativeDate: '1 day ago',
    message: 'feat: add stash support with pop and drop actions',
  },
  {
    hash: 'mno5678901234',
    shortHash: 'mno5678',
    author: 'Argenis Leon',
    relativeDate: '1 day ago',
    message: 'chore: update dependencies and fix type errors',
  },
  {
    hash: 'pqr6789012345',
    shortHash: 'pqr6789',
    author: 'Claude',
    relativeDate: '2 days ago',
    message: 'feat: implement commit history tab with virtual scrolling',
  },
  {
    hash: 'stu7890123456',
    shortHash: 'stu7890',
    author: 'Argenis Leon',
    relativeDate: '3 days ago',
    message: 'fix: resolve merge conflict in shared types',
  },
];

// ── Mock data for Stash tab ──

const mockStashEntries = [
  {
    index: 'stash@{0}',
    message: 'WIP: refactoring review pane toolbar',
    branch: 'feat/review-pane',
    relativeDate: '10 minutes ago',
  },
  {
    index: 'stash@{1}',
    message: 'WIP: experimental diff viewer layout',
    branch: 'feat/review-pane',
    relativeDate: '2 hours ago',
  },
  {
    index: 'stash@{2}',
    message: 'Saving progress on PR summary card',
    branch: 'feat/pr-summary',
    relativeDate: '1 day ago',
  },
];

const mockStashFiles = [
  { path: 'packages/client/src/components/ReviewPane.tsx', additions: 25, deletions: 10 },
  { path: 'packages/client/src/components/FileTree.tsx', additions: 8, deletions: 3 },
  { path: 'packages/client/src/lib/utils.ts', additions: 4, deletions: 1 },
];

// ── Mock data for PRs tab ──

const mockPRs = [
  {
    number: 42,
    title: 'feat: add file tree component with collapsible folders',
    state: 'open' as const,
    html_url: 'https://github.com/user/funny/pull/42',
    user: { login: 'argenisleon', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
    created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    updated_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    head: { ref: 'feat/review-pane', label: 'user:feat/review-pane' },
    base: { ref: 'master', label: 'user:master' },
    draft: false,
    labels: [{ name: 'enhancement', color: 'a2eeef' }],
    merged_at: null,
  },
  {
    number: 41,
    title: 'fix: correct diff stats for binary files',
    state: 'open' as const,
    html_url: 'https://github.com/user/funny/pull/41',
    user: { login: 'claude-bot', avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4' },
    created_at: new Date(Date.now() - 24 * 3600_000).toISOString(),
    updated_at: new Date(Date.now() - 6 * 3600_000).toISOString(),
    head: { ref: 'fix/binary-diff', label: 'user:fix/binary-diff' },
    base: { ref: 'master', label: 'user:master' },
    draft: true,
    labels: [{ name: 'bug', color: 'd73a4a' }],
    merged_at: null,
  },
  {
    number: 40,
    title: 'refactor: extract git operations into core package',
    state: 'closed' as const,
    html_url: 'https://github.com/user/funny/pull/40',
    user: { login: 'argenisleon', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
    created_at: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
    updated_at: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
    head: { ref: 'refactor/core-git', label: 'user:refactor/core-git' },
    base: { ref: 'master', label: 'user:master' },
    draft: false,
    labels: [],
    merged_at: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
  },
];

interface MockFetchOptions {
  diffResponse?: DiffSummaryResponse;
  logEntries?: typeof mockLogEntries;
  stashEntries?: typeof mockStashEntries;
  prs?: typeof mockPRs;
}

function installMockFetch(opts: MockFetchOptions = {}) {
  const {
    diffResponse = mockDiffSummaryResponse,
    logEntries = [],
    stashEntries = [],
    prs = [],
  } = opts;
  const gitStatus = makeGitStatus();

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    const json = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    // ── Git endpoints ──
    if (url.includes('/diff/summary')) return json(diffResponse);
    if (url.includes('/diff/file')) return json({ diff: mockDiff });
    if (url.includes('/stash/list')) return json({ entries: stashEntries });
    if (url.includes('/stash/show')) return json({ files: mockStashFiles });
    if (url.includes('/remote-url')) return json({ url: 'https://github.com/user/funny.git' });
    if (url.includes('/commit-msg') || url.includes('/generate-commit-message')) {
      return json({
        title: 'feat: add file tree component',
        body: 'Add collapsible tree with diff stats.',
      });
    }
    if (url.includes('/status')) return json(gitStatus);
    if (url.includes('/branches')) return json({ branches: ['master', 'feat/review-pane'] });
    if (url.includes('/pr/summary')) return json({ summary: null });

    // ── Commit detail endpoints (triggered when a commit is selected, e.g. from localStorage) ──
    if (url.includes('/commit/') && url.includes('/files')) return json({ files: [] });
    if (url.includes('/commit/') && url.includes('/diff')) return json({ diff: '' });
    if (url.includes('/commit/') && url.includes('/body')) return json({ body: '' });

    // ── History tab ──
    if (url.includes('/log'))
      return json({
        entries: logEntries,
        hasMore: false,
        unpushedHashes: logEntries.length > 0 ? [logEntries[0].hash] : [],
      });

    // ── PRs tab ──
    if (url.includes('/github/prs'))
      return json({ prs, hasMore: false, owner: 'user', repo: 'funny' });

    // ── Catch-all: return empty 200 so nothing throws ──
    return json({});
  }) as typeof window.fetch;
}

function restoreFetch() {
  window.fetch = _realFetch;
}

// ── Store seeders ───────────────────────────────────────────

function seedStores(
  opts: {
    hasThread?: boolean;
    isWorktree?: boolean;
    hasChanges?: boolean;
    hasPR?: boolean;
    isRunning?: boolean;
    tab?: 'changes' | 'history' | 'stash' | 'prs';
  } = {},
) {
  const {
    hasThread = true,
    isWorktree = true,
    hasChanges = true,
    hasPR = false,
    isRunning = false,
    tab = 'changes',
  } = opts;

  useProjectStore.setState({
    projects: [
      {
        id: 'proj-1',
        name: 'funny',
        path: '/home/user/projects/funny',
        color: '#3b82f6',
        userId: 'user-1',
        sortOrder: 0,
        createdAt: new Date().toISOString(),
      },
    ],
    expandedProjects: new Set(['proj-1']),
    selectedProjectId: 'proj-1',
    initialized: true,
    branchByProject: { 'proj-1': 'master' },
  });

  const thread = {
    id: 'thread-1',
    projectId: 'proj-1',
    userId: 'user-1',
    title: 'add file tree component',
    mode: isWorktree ? ('worktree' as const) : ('local' as const),
    status: isRunning ? ('running' as const) : ('completed' as const),
    stage: isRunning ? ('in_progress' as const) : ('done' as const),
    provider: 'claude' as const,
    permissionMode: 'autoEdit' as const,
    model: 'sonnet' as const,
    branch: 'feat/review-pane',
    baseBranch: 'master',
    cost: 0.24,
    runtime: 'local' as const,
    source: 'web' as const,
    worktreePath: isWorktree ? '/home/user/projects/funny/.worktrees/feat-review-pane' : undefined,
    createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    completedAt: isRunning ? undefined : new Date(Date.now() - 5 * 60_000).toISOString(),
  };

  if (hasThread) {
    useThreadStore.setState({
      threadsByProject: { 'proj-1': [thread] },
      selectedThreadId: 'thread-1',
      activeThread: { ...thread, messages: [] },
      setupProgressByThread: {},
      contextUsageByThread: {},
    });
  } else {
    useThreadStore.setState({
      threadsByProject: {},
      selectedThreadId: null,
      activeThread: null,
      setupProgressByThread: {},
      contextUsageByThread: {},
    });
  }

  useGitStatusStore.setState({
    statusByBranch: {
      'proj-1:feat/review-pane': makeGitStatus({
        dirtyFileCount: hasChanges ? mockFiles.length : 0,
        linesAdded: hasChanges ? 417 : 0,
        linesDeleted: hasChanges ? 194 : 0,
        state: hasChanges ? 'dirty' : 'clean',
        prNumber: hasPR ? 42 : undefined,
        prUrl: hasPR ? 'https://github.com/user/funny/pull/42' : undefined,
        prState: hasPR ? 'OPEN' : undefined,
      }),
    },
    threadToBranchKey: { 'thread-1': 'proj-1:feat/review-pane' },
    statusByProject: {},
    loadingProjects: new Set(),
    _loadingBranchKeys: new Set(),
    _loadingProjectStatus: new Set(),
  });

  useUIStore.setState({
    reviewPaneOpen: true,
    reviewSubTab: tab,
    settingsOpen: false,
    rightPaneTab: 'review',
  });

  useReviewPaneStore.setState({
    dirtySignal: 0,
    dirtyThreadId: null,
    generatingCommitMsg: {},
  });

  useCommitProgressStore.setState({
    activeCommits: {},
    failedWorkflow: null,
  });

  useSettingsStore.setState({
    defaultEditor: 'cursor',
    useInternalEditor: false,
    _initialized: true,
  });
}

// ── Wrapper ─────────────────────────────────────────────────

const EMPTY_MOCK_OPTS: MockFetchOptions = {};

function ReviewPaneWrapper({
  mockFetchOpts = EMPTY_MOCK_OPTS,
}: {
  mockFetchOpts?: MockFetchOptions;
}) {
  // Install mock fetch synchronously BEFORE the first render so that
  // ReviewPane's mount effect (which fires before parent effects) hits
  // the mock instead of the real network — fixing "Failed to load changes".
  installMockFetch(mockFetchOpts);

  useEffect(() => {
    return () => restoreFetch();
  }, [mockFetchOpts]);

  return (
    <MemoryRouter>
      <Toaster />
      {/*
       * Position ReviewPane on the far right of the viewport, just like
       * in the real app. This is critical because the expanded diff
       * overlay uses createPortal(…, document.body) with position:fixed
       * and `right: panelWidthPx`. Anchoring the panel to the right edge
       * ensures the portal fills the left portion of the screen correctly.
       */}
      <div
        className="fixed right-0 top-0 flex flex-col bg-sidebar"
        style={{ width: 400, height: '100vh', overflow: 'hidden' }}
      >
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">
            <ReviewPane />
          </div>
        </div>
      </div>
    </MemoryRouter>
  );
}

// ── Meta ────────────────────────────────────────────────────

const meta = {
  title: 'Components/ReviewPane',
  component: ReviewPane,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof ReviewPane>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Stories ─────────────────────────────────────────────────

// ── Changes tab stories ────────────────────────────────────

/** Full review pane with staged and unstaged file changes. */
export const Default: Story = {
  render: () => {
    seedStores({ hasThread: true, isWorktree: true, hasChanges: true });
    return <ReviewPaneWrapper />;
  },
};

/** No changes — clean working tree. */
export const NoChanges: Story = {
  name: 'No Changes',
  render: () => {
    seedStores({ hasThread: true, isWorktree: true, hasChanges: false });
    return <ReviewPaneWrapper mockFetchOpts={{ diffResponse: emptyDiffSummaryResponse }} />;
  },
};

/** With an open pull request shown in the header. */
export const WithPullRequest: Story = {
  name: 'With Pull Request',
  render: () => {
    seedStores({ hasThread: true, isWorktree: true, hasChanges: true, hasPR: true });
    return <ReviewPaneWrapper />;
  },
};

/** Agent is still running — action buttons are disabled. */
export const AgentRunning: Story = {
  name: 'Agent Running',
  render: () => {
    seedStores({ hasThread: true, isWorktree: true, hasChanges: true, isRunning: true });
    return <ReviewPaneWrapper />;
  },
};

/** Local mode (not a worktree). */
export const LocalMode: Story = {
  name: 'Local Mode',
  render: () => {
    seedStores({ hasThread: true, isWorktree: false, hasChanges: true });
    return <ReviewPaneWrapper />;
  },
};

/** Project mode — no thread selected, diff from project root. */
export const ProjectMode: Story = {
  name: 'Project Mode (No Thread)',
  render: () => {
    seedStores({ hasThread: false, hasChanges: true });
    return <ReviewPaneWrapper />;
  },
};

/** Commit workflow in progress with step indicators. */
export const CommitInProgress: Story = {
  name: 'Commit In Progress',
  render: () => {
    seedStores({ hasThread: true, isWorktree: true, hasChanges: true });
    useCommitProgressStore.setState({
      activeCommits: {
        'thread-1': {
          title: 'Committing and pushing...',
          action: 'commit-push',
          steps: [
            { id: 'stage', label: 'Stage files', status: 'completed' },
            { id: 'hooks', label: 'Pre-commit hooks', status: 'completed' },
            { id: 'commit', label: 'Create commit', status: 'running' },
            { id: 'push', label: 'Push to remote', status: 'pending' },
          ],
        },
      },
    });
    return <ReviewPaneWrapper />;
  },
};

/** Truncated file list warning. */
export const TruncatedFiles: Story = {
  name: 'Truncated File List',
  render: () => {
    seedStores({ hasThread: true, isWorktree: true, hasChanges: true });
    return (
      <ReviewPaneWrapper
        mockFetchOpts={{ diffResponse: { files: mockFiles, total: 250, truncated: true } }}
      />
    );
  },
};

// ── History tab stories ────────────────────────────────────

/** Commit history with recent commits and unpushed indicator. */
export const HistoryTab: Story = {
  name: 'History Tab',
  render: () => {
    seedStores({ hasThread: true, isWorktree: true, hasChanges: false, tab: 'history' });
    return <ReviewPaneWrapper mockFetchOpts={{ logEntries: mockLogEntries }} />;
  },
};

/** History tab with no commits. */
export const HistoryTabEmpty: Story = {
  name: 'History Tab (Empty)',
  render: () => {
    seedStores({ hasThread: true, isWorktree: true, hasChanges: false, tab: 'history' });
    return <ReviewPaneWrapper mockFetchOpts={{ logEntries: [] }} />;
  },
};

// ── Stash tab stories ──────────────────────────────────────

/** Stash tab with several stashed changes. */
export const StashTab: Story = {
  name: 'Stash Tab',
  render: () => {
    seedStores({ hasThread: true, isWorktree: true, hasChanges: false, tab: 'stash' });
    return <ReviewPaneWrapper mockFetchOpts={{ stashEntries: mockStashEntries }} />;
  },
};

/** Stash tab with no stashed changes. */
export const StashTabEmpty: Story = {
  name: 'Stash Tab (Empty)',
  render: () => {
    seedStores({ hasThread: true, isWorktree: true, hasChanges: false, tab: 'stash' });
    return <ReviewPaneWrapper mockFetchOpts={{ stashEntries: [] }} />;
  },
};

// ── PRs tab stories ────────────────────────────────────────

/** Pull requests tab with open, draft, and merged PRs. */
export const PRsTab: Story = {
  name: 'PRs Tab',
  render: () => {
    seedStores({ hasThread: true, isWorktree: true, hasChanges: false, tab: 'prs' });
    return <ReviewPaneWrapper mockFetchOpts={{ prs: mockPRs }} />;
  },
};

/** PRs tab with no pull requests. */
export const PRsTabEmpty: Story = {
  name: 'PRs Tab (Empty)',
  render: () => {
    seedStores({ hasThread: true, isWorktree: true, hasChanges: false, tab: 'prs' });
    return <ReviewPaneWrapper mockFetchOpts={{ prs: [] }} />;
  },
};
