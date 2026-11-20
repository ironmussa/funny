import type { Thread, GitStatusInfo } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { ThreadPowerline } from '@/components/ThreadPowerline';
import { buildThread } from '@/data/threads/testing';

/** Minimal thread mock — only the fields ThreadPowerline reads. */
function mockThread(overrides: Partial<Thread> = {}): Thread {
  return buildThread({
    id: 'thread-1',
    projectId: 'proj-1',
    userId: 'user-1',
    title: 'Test thread',
    status: 'idle',
    provider: 'claude-sdk',
    ...overrides,
  });
}

const gitDirty: GitStatusInfo = {
  threadId: 'thread-1',
  branchKey: 'main',
  state: 'dirty',
  linesAdded: 142,
  linesDeleted: 37,
  dirtyFileCount: 5,
  unpushedCommitCount: 2,
  unpulledCommitCount: 0,
  hasRemoteBranch: true,
  isMergedIntoBase: false,
};

const gitClean: GitStatusInfo = {
  threadId: 'thread-1',
  branchKey: 'main',
  state: 'clean',
  linesAdded: 0,
  linesDeleted: 0,
  dirtyFileCount: 0,
  unpushedCommitCount: 0,
  unpulledCommitCount: 0,
  hasRemoteBranch: true,
  isMergedIntoBase: false,
};

const meta = {
  title: 'Components/ThreadPowerline',
  component: ThreadPowerline,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['arrow', 'chips'],
    },
    diffStatsSize: {
      control: 'select',
      options: ['sm', 'xs', 'xxs'],
    },
  },
} satisfies Meta<typeof ThreadPowerline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LocalThread: Story = {
  args: {
    thread: mockThread({ mode: 'local', baseBranch: 'main' }),
    projectName: 'funny',
    projectColor: '#7CB9E8',
  },
};

export const WorktreeThread: Story = {
  args: {
    thread: mockThread({
      mode: 'worktree',
      baseBranch: 'main',
      branch: 'feat/powerline-stories',
    }),
    projectName: 'funny',
    projectColor: '#7CB9E8',
  },
};

export const WithDiffStats: Story = {
  args: {
    thread: mockThread({
      mode: 'worktree',
      baseBranch: 'main',
      branch: 'feat/auth',
    }),
    projectName: 'backend',
    projectColor: '#10b981',
    gitStatus: gitDirty,
  },
};

export const CleanGitStatus: Story = {
  args: {
    thread: mockThread({
      mode: 'worktree',
      baseBranch: 'develop',
      branch: 'feat/clean',
    }),
    projectName: 'api',
    projectColor: '#3b82f6',
    gitStatus: gitClean,
  },
};

export const NoProject: Story = {
  args: {
    thread: mockThread({ mode: 'local', baseBranch: 'main' }),
  },
};

export const BranchOnly: Story = {
  args: {
    thread: mockThread({ mode: 'local', baseBranch: 'develop' }),
  },
};

export const ChipsVariant: Story = {
  args: {
    thread: mockThread({
      mode: 'worktree',
      baseBranch: 'main',
      branch: 'feat/new-ui',
    }),
    projectName: 'funny',
    projectColor: '#8b5cf6',
    variant: 'chips',
    gitStatus: gitDirty,
  },
};

export const WithProjectTooltip: Story = {
  args: {
    thread: mockThread({
      mode: 'worktree',
      baseBranch: 'main',
      branch: 'fix/tooltip',
    }),
    projectName: 'funny',
    projectColor: '#f59e0b',
    projectTooltip: '/home/user/projects/funny',
    gitStatus: gitDirty,
  },
};

export const SmallDiffStats: Story = {
  args: {
    thread: mockThread({
      mode: 'worktree',
      baseBranch: 'main',
      branch: 'feat/small',
    }),
    projectName: 'frontend',
    projectColor: '#ef4444',
    gitStatus: {
      threadId: 'thread-1',
      branchKey: 'main',
      state: 'dirty',
      linesAdded: 12,
      linesDeleted: 3,
      dirtyFileCount: 2,
      unpushedCommitCount: 0,
      unpulledCommitCount: 0,
      hasRemoteBranch: true,
      isMergedIntoBase: false,
    },
    diffStatsSize: 'xxs',
  },
};

export const MultipleExamples: Story = {
  args: {
    thread: mockThread({ mode: 'local', baseBranch: 'main' }),
  },
  render: () => (
    <div className="flex flex-col gap-3">
      <ThreadPowerline
        thread={mockThread({ mode: 'local', baseBranch: 'main' })}
        projectName="frontend"
        projectColor="#3b82f6"
      />
      <ThreadPowerline
        thread={mockThread({ mode: 'worktree', baseBranch: 'main', branch: 'feat/auth' })}
        projectName="backend"
        projectColor="#10b981"
        gitStatus={gitDirty}
      />
      <ThreadPowerline
        thread={mockThread({ mode: 'worktree', baseBranch: 'develop', branch: 'fix/hotfix' })}
        projectName="infra"
        projectColor="#f59e0b"
        gitStatus={{
          threadId: 'thread-1',
          branchKey: 'develop',
          state: 'dirty',
          linesAdded: 5,
          linesDeleted: 80,
          dirtyFileCount: 1,
          unpushedCommitCount: 0,
          unpulledCommitCount: 0,
          hasRemoteBranch: true,
          isMergedIntoBase: false,
        }}
      />
      <ThreadPowerline
        thread={mockThread({ mode: 'local', baseBranch: 'release/v2' })}
        projectName="docs"
        projectColor="#8b5cf6"
      />
      <ThreadPowerline
        thread={mockThread({
          mode: 'worktree',
          baseBranch: 'main',
          branch: 'feat/very-long-branch-name-for-testing-truncation',
        })}
        projectName="my-long-project-name"
        projectColor="#ef4444"
        gitStatus={gitDirty}
        className="max-w-80"
      />
    </div>
  ),
};
