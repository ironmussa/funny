import type { Project, Thread, GitStatusInfo } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { SidebarProvider } from '@/components/ui/sidebar';
import { useAuthStore } from '@/stores/auth-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { AppSidebar } from './Sidebar';

// ── Mock factories ───────────────────────────────────────────────

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'funny',
    path: '/home/user/projects/funny',
    color: '#3b82f6',
    userId: 'user-1',
    sortOrder: 0,
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString(),
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    projectId: 'proj-1',
    userId: 'user-1',
    title: 'add the line diff github component to storybook',
    mode: 'worktree',
    status: 'completed',
    stage: 'done',
    provider: 'claude',
    permissionMode: 'autoEdit',
    model: 'sonnet',
    branch: 'feat/inline-diff',
    baseBranch: 'master',
    cost: 0.12,
    runtime: 'local',
    source: 'web',
    purpose: 'implement',
    createdAt: new Date(Date.now() - 57 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 57 * 60_000).toISOString(),
    completedAt: new Date(Date.now() - 55 * 60_000).toISOString(),
    lastAssistantMessage:
      "Now I have the 'DiffStats' component. Let me check how other stories handle that…",
    ...overrides,
  };
}

function makeGitStatus(overrides: Partial<GitStatusInfo> = {}): GitStatusInfo {
  return {
    threadId: 'thread-1',
    branchKey: 'proj-1:feat/inline-diff',
    state: 'dirty',
    dirtyFileCount: 48,
    unpushedCommitCount: 0,
    unpulledCommitCount: 0,
    hasRemoteBranch: false,
    isMergedIntoBase: false,
    linesAdded: 5604,
    linesDeleted: 1137,
    ...overrides,
  };
}

// ── Store seeders ────────────────────────────────────────────────

function seedDefault() {
  const projects: Project[] = [
    makeProject({
      id: 'proj-1',
      name: 'funny',
      color: '#3b82f6',
      path: '/home/user/projects/funny',
    }),
    makeProject({
      id: 'proj-2',
      name: 'api-server',
      color: '#ef4444',
      path: '/home/user/projects/api',
    }),
    makeProject({
      id: 'proj-3',
      name: 'design-system',
      color: '#a855f7',
      path: '/home/user/projects/ds',
    }),
  ];

  const threadsByProject: Record<string, Thread[]> = {
    'proj-1': [
      makeThread({
        id: 't1',
        projectId: 'proj-1',
        status: 'running',
        title: 'refactor authentication module',
        lastAssistantMessage: 'Installing the new OAuth provider…',
        completedAt: undefined,
        createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      }),
      makeThread({
        id: 't2',
        projectId: 'proj-1',
        title: 'add the line diff github component',
        createdAt: new Date(Date.now() - 57 * 60_000).toISOString(),
        completedAt: new Date(Date.now() - 55 * 60_000).toISOString(),
      }),
      makeThread({
        id: 't3',
        projectId: 'proj-1',
        title: 'fix login redirect after OAuth',
        lastAssistantMessage: 'The redirect URL was missing the callback path.',
        createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
        completedAt: new Date(Date.now() - 88 * 60_000).toISOString(),
      }),
    ],
    'proj-2': [
      makeThread({
        id: 't4',
        projectId: 'proj-2',
        title: 'add dark mode support',
        status: 'running',
        lastAssistantMessage: 'Updating CSS variables…',
        completedAt: undefined,
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        branch: 'feat/dark-mode',
      }),
      makeThread({
        id: 't5',
        projectId: 'proj-2',
        title: 'upgrade to Node 22',
        lastAssistantMessage: 'Updated package.json engines field.',
        createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        completedAt: new Date(Date.now() - 178 * 60_000).toISOString(),
      }),
    ],
    'proj-3': [],
  };

  useProjectStore.setState({
    projects,
    expandedProjects: new Set(['proj-1', 'proj-2']),
    selectedProjectId: 'proj-1',
    initialized: true,
    branchByProject: { 'proj-1': 'master', 'proj-2': 'main' },
  });

  useThreadStore.setState({
    threadsByProject,
    selectedThreadId: 't2',
    activeThread: null,
    setupProgressByThread: {},
    contextUsageByThread: {},
  });

  useAuthStore.setState({
    user: { id: 'user-1', username: 'admin', displayName: 'Admin User', role: 'admin' },
    isAuthenticated: true,
    isLoading: false,
    activeOrgId: null,
    activeOrgName: null,
    activeOrgSlug: null,
  });

  useUIStore.setState({ settingsOpen: false });

  // Seed git status
  useGitStatusStore.setState({
    statusByBranch: {
      'proj-1:feat/inline-diff': makeGitStatus({
        threadId: 't2',
        branchKey: 'proj-1:feat/inline-diff',
      }),
      'proj-1:feat/auth-refactor': makeGitStatus({
        threadId: 't1',
        branchKey: 'proj-1:feat/auth-refactor',
        state: 'dirty',
        dirtyFileCount: 8,
        linesAdded: 120,
        linesDeleted: 30,
      }),
      'proj-2:feat/dark-mode': makeGitStatus({
        threadId: 't4',
        branchKey: 'proj-2:feat/dark-mode',
        state: 'dirty',
        dirtyFileCount: 3,
        linesAdded: 80,
        linesDeleted: 10,
      }),
      'proj-2:feat/node22': makeGitStatus({
        threadId: 't5',
        branchKey: 'proj-2:feat/node22',
        state: 'pushed',
        dirtyFileCount: 0,
        linesAdded: 0,
        linesDeleted: 0,
        hasRemoteBranch: true,
      }),
    },
    threadToBranchKey: {
      t1: 'proj-1:feat/auth-refactor',
      t2: 'proj-1:feat/inline-diff',
      t4: 'proj-2:feat/dark-mode',
      t5: 'proj-2:feat/node22',
    },
    statusByProject: {},
    loadingProjects: new Set(),
    _loadingBranchKeys: new Set(),
    _loadingProjectStatus: new Set(),
  });
}

function seedEmpty() {
  useProjectStore.setState({
    projects: [],
    expandedProjects: new Set(),
    selectedProjectId: null,
    initialized: true,
    branchByProject: {},
  });
  useThreadStore.setState({
    threadsByProject: {},
    selectedThreadId: null,
    activeThread: null,
    setupProgressByThread: {},
    contextUsageByThread: {},
  });
  useAuthStore.setState({
    user: { id: 'user-1', username: 'admin', displayName: 'Admin User', role: 'admin' },
    isAuthenticated: true,
    isLoading: false,
    activeOrgId: null,
    activeOrgName: null,
    activeOrgSlug: null,
  });
  useUIStore.setState({ settingsOpen: false });
  useGitStatusStore.setState({
    statusByBranch: {},
    threadToBranchKey: {},
    statusByProject: {},
    loadingProjects: new Set(),
    _loadingBranchKeys: new Set(),
    _loadingProjectStatus: new Set(),
  });
}

// ── Wrapper ──────────────────────────────────────────────────────

function SidebarWrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <SidebarProvider>
        <div className="flex h-screen w-[280px] overflow-hidden">{children}</div>
      </SidebarProvider>
    </MemoryRouter>
  );
}

// ── Meta ─────────────────────────────────────────────────────────

const meta = {
  title: 'Sidebar/AppSidebar',
  component: AppSidebar,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof AppSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Stories ──────────────────────────────────────────────────────

/** Full sidebar with projects, running and completed threads. */
export const Default: Story = {
  render: () => {
    seedDefault();
    return (
      <SidebarWrapper>
        <AppSidebar />
      </SidebarWrapper>
    );
  },
};

/** Empty state — no projects added yet. */
export const Empty: Story = {
  render: () => {
    seedEmpty();
    return (
      <SidebarWrapper>
        <AppSidebar />
      </SidebarWrapper>
    );
  },
};

/** Single project with only completed threads (no active). */
export const SingleProjectNoActive: Story = {
  name: 'Single Project (No Active)',
  render: () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'proj-1', name: 'funny', color: '#3b82f6' })],
      expandedProjects: new Set(['proj-1']),
      selectedProjectId: 'proj-1',
      initialized: true,
      branchByProject: { 'proj-1': 'master' },
    });
    useThreadStore.setState({
      threadsByProject: {
        'proj-1': [
          makeThread({ id: 't1', title: 'add the inline diff component' }),
          makeThread({
            id: 't2',
            title: 'fix login redirect',
            createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
            completedAt: new Date(Date.now() - 88 * 60_000).toISOString(),
          }),
          makeThread({
            id: 't3',
            title: 'upgrade dependencies',
            status: 'failed',
            createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
            completedAt: new Date(Date.now() - 178 * 60_000).toISOString(),
          }),
        ],
      },
      selectedThreadId: 't1',
      activeThread: null,
      setupProgressByThread: {},
      contextUsageByThread: {},
    });
    useAuthStore.setState({
      user: { id: 'user-1', username: 'jane', displayName: 'Jane Smith', role: 'user' },
      isAuthenticated: true,
      isLoading: false,
      activeOrgId: null,
      activeOrgName: null,
      activeOrgSlug: null,
    });
    useUIStore.setState({ settingsOpen: false });
    useGitStatusStore.setState({
      statusByBranch: {
        'proj-1:feat/inline-diff': makeGitStatus({
          threadId: 't1',
          branchKey: 'proj-1:feat/inline-diff',
        }),
      },
      threadToBranchKey: { t1: 'proj-1:feat/inline-diff' },
      statusByProject: {},
      loadingProjects: new Set(),
      _loadingBranchKeys: new Set(),
      _loadingProjectStatus: new Set(),
    });
    return (
      <SidebarWrapper>
        <AppSidebar />
      </SidebarWrapper>
    );
  },
};
