import type { GitStatusInfo, Thread, ThreadStage, Project } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAppStore } from '@/stores/app-store';
import { useAuthStore } from '@/stores/auth-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useThreadStore } from '@/stores/thread-store';

import { KanbanView } from './KanbanView';

// ── Helpers ──────────────────────────────────────────────────────

let counter = 0;
function uid() {
  return `id-${++counter}`;
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  const id = overrides.id ?? uid();
  return {
    id,
    projectId: 'proj-1',
    userId: 'user-1',
    title: 'Refactor auth module',
    mode: 'worktree',
    status: 'completed',
    stage: 'backlog',
    provider: 'claude',
    permissionMode: 'autoEdit',
    model: 'sonnet',
    branch: 'feat/auth',
    baseBranch: 'master',
    cost: 0.12,
    runtime: 'local',
    source: 'web',
    purpose: 'implement',
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date(Date.now() - 55 * 60_000).toISOString(),
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'funny',
    path: '/home/user/funny',
    userId: 'user-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Project;
}

function seedStores(projects: Project[] = [makeProject()]) {
  useAuthStore.setState({
    user: { id: 'user-1', username: 'admin', displayName: 'Admin User', role: 'admin' },
    isAuthenticated: true,
    isLoading: false,
    activeOrgId: null,
    activeOrgName: null,
    activeOrgSlug: null,
  });

  useAppStore.setState({ projects });

  const noop = (() => Promise.resolve()) as any;
  useThreadStore.setState({
    updateThreadStage: noop,
    archiveThread: noop,
    unarchiveThread: noop,
    deleteThread: noop,
    pinThread: noop,
    selectedThreadId: null,
  });

  useGitStatusStore.setState({ statusByBranch: {} });
}

function makeThreadsForStages(stages: Partial<Record<ThreadStage, number>>): Thread[] {
  const threads: Thread[] = [];
  const titles: Record<string, string[]> = {
    backlog: ['Investigate slow queries', 'Add CSV export', 'Upgrade to React 19'],
    planning: ['Design new onboarding flow', 'Plan API v2 migration'],
    in_progress: ['Add dark mode support', 'Fix WebSocket reconnection', 'Implement file upload'],
    review: ['Refactor auth module', 'Add E2E tests for checkout'],
    done: ['Fix typo in README', 'Update dependencies', 'Add rate limiting'],
    archived: ['Old migration script', 'Deprecated API cleanup'],
  };

  for (const [stage, count] of Object.entries(stages)) {
    const stageTitles = titles[stage] ?? ['Thread'];
    for (let i = 0; i < (count ?? 0); i++) {
      const status =
        stage === 'in_progress'
          ? 'running'
          : stage === 'backlog' || stage === 'planning'
            ? 'idle'
            : 'completed';
      threads.push(
        makeThread({
          title: stageTitles[i % stageTitles.length],
          stage: stage as ThreadStage,
          status,
          archived: stage === 'archived',
          branch: `feat/${stage}-${i}`,
          createdAt: new Date(Date.now() - (i + 1) * 30 * 60_000).toISOString(),
          completedAt:
            status === 'completed'
              ? new Date(Date.now() - i * 25 * 60_000).toISOString()
              : undefined,
          cost: Math.random() * 0.5,
        }),
      );
    }
  }

  return threads;
}

// ── Meta ─────────────────────────────────────────────────────────

const meta = {
  title: 'Components/KanbanView',
  component: KanbanView,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  decorators: [
    (Story) => {
      counter = 0;
      seedStores();
      return (
        <MemoryRouter>
          <TooltipProvider>
            <div className="h-[600px] w-full bg-background">
              <Story />
            </div>
          </TooltipProvider>
        </MemoryRouter>
      );
    },
  ],
} satisfies Meta<typeof KanbanView>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Stories ──────────────────────────────────────────────────────

export const Default: Story = {
  args: {
    threads: makeThreadsForStages({
      backlog: 3,
      planning: 2,
      in_progress: 3,
      review: 2,
      done: 3,
      archived: 2,
    }),
  },
};

export const Empty: Story = {
  name: 'Empty Board',
  args: {
    threads: [],
  },
};

export const SingleColumn: Story = {
  name: 'Only In Progress',
  args: {
    threads: makeThreadsForStages({ in_progress: 5 }),
  },
};

export const HeavyBacklog: Story = {
  name: 'Heavy Backlog',
  args: {
    threads: makeThreadsForStages({
      backlog: 25,
      planning: 1,
      in_progress: 2,
    }),
  },
};

export const WithSearchHighlight: Story = {
  name: 'With Search',
  args: {
    threads: makeThreadsForStages({
      backlog: 3,
      in_progress: 2,
      done: 3,
    }),
    search: 'dark',
  },
};

export const FilteredByProject: Story = {
  name: 'Filtered by Project',
  decorators: [
    (Story) => {
      counter = 0;
      seedStores([
        makeProject({ id: 'proj-1', name: 'funny', color: '#3b82f6' }),
        makeProject({ id: 'proj-2', name: 'api-server', color: '#ef4444' }),
      ]);
      return (
        <MemoryRouter>
          <TooltipProvider>
            <div className="h-[600px] w-full bg-background">
              <Story />
            </div>
          </TooltipProvider>
        </MemoryRouter>
      );
    },
  ],
  args: {
    threads: makeThreadsForStages({ backlog: 2, in_progress: 3, review: 1, done: 2 }),
    projectId: 'proj-1',
  },
};

export const MultiProject: Story = {
  name: 'Multi-Project View',
  decorators: [
    (Story) => {
      counter = 0;
      seedStores([
        makeProject({ id: 'proj-1', name: 'funny', color: '#3b82f6' }),
        makeProject({ id: 'proj-2', name: 'api-server', color: '#ef4444' }),
        makeProject({ id: 'proj-3', name: 'design-system', color: '#a855f7' }),
      ]);
      return (
        <MemoryRouter>
          <TooltipProvider>
            <div className="h-[600px] w-full bg-background">
              <Story />
            </div>
          </TooltipProvider>
        </MemoryRouter>
      );
    },
  ],
  args: {
    threads: [
      ...makeThreadsForStages({ backlog: 2, in_progress: 1 }).map((t) => ({
        ...t,
        projectId: 'proj-1',
      })),
      ...makeThreadsForStages({ review: 2, done: 1 }).map((t) => ({
        ...t,
        projectId: 'proj-2',
      })),
      ...makeThreadsForStages({ planning: 1, in_progress: 2 }).map((t) => ({
        ...t,
        projectId: 'proj-3',
      })),
    ],
  },
};

export const WithGitStatus: Story = {
  name: 'With Git Status',
  decorators: [
    (Story) => {
      counter = 0;
      const statusByBranch: Record<string, GitStatusInfo> = {
        'proj-1:feat/review-0': {
          threadId: 'id-1',
          branchKey: 'proj-1:feat/review-0',
          state: 'dirty',
          dirtyFileCount: 8,
          unpushedCommitCount: 0,
          unpulledCommitCount: 0,
          hasRemoteBranch: false,
          isMergedIntoBase: false,
          linesAdded: 245,
          linesDeleted: 42,
        },
        'proj-1:feat/review-1': {
          threadId: 'id-2',
          branchKey: 'proj-1:feat/review-1',
          state: 'unpushed',
          dirtyFileCount: 0,
          unpushedCommitCount: 3,
          unpulledCommitCount: 0,
          hasRemoteBranch: true,
          isMergedIntoBase: false,
          linesAdded: 120,
          linesDeleted: 15,
        },
      };
      seedStores();
      useGitStatusStore.setState({ statusByBranch });
      return (
        <MemoryRouter>
          <TooltipProvider>
            <div className="h-[600px] w-full bg-background">
              <Story />
            </div>
          </TooltipProvider>
        </MemoryRouter>
      );
    },
  ],
  args: {
    threads: makeThreadsForStages({ review: 2, done: 2, in_progress: 1 }),
  },
};

export const WithPinnedThreads: Story = {
  name: 'With Pinned Threads',
  args: {
    threads: [
      makeThread({
        title: 'Pinned: Critical auth fix',
        stage: 'in_progress',
        status: 'running',
        pinned: true,
        branch: 'fix/auth-critical',
      }),
      makeThread({
        title: 'Pinned: Urgent DB migration',
        stage: 'in_progress',
        status: 'running',
        pinned: true,
        branch: 'fix/db-migration',
      }),
      ...makeThreadsForStages({ in_progress: 3, backlog: 2, done: 2 }),
    ],
  },
};
