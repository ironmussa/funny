import type { GitStatusInfo, Thread } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';

import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';

import { ThreadItem } from './ThreadItem';

// ── Mock thread factory ───────────────────────────────────────────
function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    projectId: 'proj-1',
    userId: 'user-1',
    title: 'add the line diff github component to st…',
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
    updatedAt: new Date().toISOString(),
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

// ── Meta ──────────────────────────────────────────────────────────
const meta = {
  title: 'Sidebar/ThreadItem',
  component: ThreadItem,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <TooltipProvider>
        <div className="w-[280px] min-w-0">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
  args: {
    onSelect: () => {},
  },
  argTypes: {
    onSelect: { action: 'select' },
    onRename: { action: 'rename' },
    onArchive: { action: 'archive' },
    onPin: { action: 'pin' },
    onDelete: { action: 'delete' },
  },
} satisfies Meta<typeof ThreadItem>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Stories ───────────────────────────────────────────────────────

/** Completed thread with diff stats and snippet — matches the screenshot. */
export const CompletedWithDiffStats: Story = {
  name: 'Completed + Diff Stats',
  args: {
    thread: makeThread(),
    projectPath: '/home/user/projects/funny',
    isSelected: false,
    gitStatus: makeGitStatus(),
    subtitle: 'funny',
    projectColor: '#3b82f6',
  },
};

/** Selected state (highlighted background). */
export const Selected: Story = {
  name: 'Selected',
  args: {
    ...CompletedWithDiffStats.args,
    isSelected: true,
  },
};

/** Running thread — shows spinner icon and no archive/delete in menu. */
export const Running: Story = {
  name: 'Running',
  args: {
    thread: makeThread({
      id: 'thread-2',
      status: 'running',
      title: 'cuando estoy haciendo un commit desde …',
      lastAssistantMessage: 'Now let me add the live pro…',
      completedAt: undefined,
      createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    }),
    projectPath: '/home/user/projects/funny',
    isSelected: false,
    gitStatus: makeGitStatus({
      threadId: 'thread-2',
      state: 'dirty',
      dirtyFileCount: 48,
      linesAdded: 5604,
      linesDeleted: 1137,
    }),
    subtitle: 'funny',
    projectColor: '#3b82f6',
  },
};

/** Setting up thread — shows spinner, no archive/delete. */
export const SettingUp: Story = {
  name: 'Setting Up',
  args: {
    thread: makeThread({
      id: 'thread-3',
      status: 'setting_up',
      title: 'refactor authentication module',
      lastAssistantMessage: undefined,
      completedAt: undefined,
    }),
    projectPath: '/home/user/projects/funny',
    isSelected: false,
  },
};

/** Pinned thread — shows pin icon instead of status icon. */
export const Pinned: Story = {
  name: 'Pinned',
  args: {
    thread: makeThread({
      pinned: true,
      title: 'fix: critical login bug',
      lastAssistantMessage: 'Fixed the authentication token refresh logic.',
    }),
    projectPath: '/home/user/projects/funny',
    isSelected: false,
    gitStatus: makeGitStatus({
      state: 'unpushed',
      unpushedCommitCount: 3,
      dirtyFileCount: 0,
      linesAdded: 42,
      linesDeleted: 18,
    }),
    subtitle: 'funny',
    projectColor: '#3b82f6',
  },
};

/** Failed thread status. */
export const Failed: Story = {
  name: 'Failed',
  args: {
    thread: makeThread({
      status: 'failed',
      title: 'add dark mode support',
      lastAssistantMessage: 'Error: Could not resolve dependency…',
    }),
    projectPath: '/home/user/projects/funny',
    isSelected: false,
    gitStatus: makeGitStatus({
      state: 'dirty',
      dirtyFileCount: 12,
      linesAdded: 200,
      linesDeleted: 50,
    }),
    subtitle: 'funny',
    projectColor: '#ef4444',
  },
};

/** Thread without project subtitle (used inside ProjectItem). */
export const WithoutSubtitle: Story = {
  name: 'Without Subtitle',
  args: {
    thread: makeThread({
      title: 'en toolbar de run command el output deb…',
      lastAssistantMessage: 'Let me query the logs to inv…',
    }),
    projectPath: '/home/user/projects/funny',
    isSelected: false,
    gitStatus: makeGitStatus(),
  },
};

/** Thread with no diff stats and no snippet — minimal row. */
export const MinimalRow: Story = {
  name: 'Minimal (no stats, no snippet)',
  args: {
    thread: makeThread({
      title: 'quick fix typo in readme',
      lastAssistantMessage: undefined,
    }),
    projectPath: '/home/user/projects/funny',
    isSelected: false,
  },
};

/** Thread with git status = pushed (no diff stats, just git icon). */
export const GitPushed: Story = {
  name: 'Git Pushed',
  args: {
    thread: makeThread({
      title: 'add user preferences endpoint',
      lastAssistantMessage: 'All tests passing. Ready to merge.',
    }),
    projectPath: '/home/user/projects/funny',
    isSelected: false,
    gitStatus: makeGitStatus({
      state: 'pushed',
      dirtyFileCount: 0,
      linesAdded: 0,
      linesDeleted: 0,
      unpushedCommitCount: 0,
      hasRemoteBranch: true,
    }),
    subtitle: 'funny',
    projectColor: '#22c55e',
  },
};

/** Thread with git status = merged. */
export const GitMerged: Story = {
  name: 'Git Merged',
  args: {
    thread: makeThread({
      title: 'feat: implement search functionality',
      lastAssistantMessage: 'Search feature merged into main.',
    }),
    projectPath: '/home/user/projects/funny',
    isSelected: false,
    gitStatus: makeGitStatus({
      state: 'merged',
      dirtyFileCount: 0,
      linesAdded: 0,
      linesDeleted: 0,
      unpushedCommitCount: 0,
      hasRemoteBranch: true,
      isMergedIntoBase: true,
    }),
    subtitle: 'funny',
    projectColor: '#a855f7',
  },
};

/** Created by an external agent (shows bot icon). */
export const CreatedByAgent: Story = {
  name: 'Created by Agent',
  args: {
    thread: makeThread({
      title: 'auto: update dependencies',
      createdBy: 'pipeline',
      lastAssistantMessage: 'Updated 12 packages to latest versions.',
    }),
    projectPath: '/home/user/projects/funny',
    isSelected: false,
    gitStatus: makeGitStatus({
      state: 'dirty',
      dirtyFileCount: 3,
      linesAdded: 45,
      linesDeleted: 30,
    }),
    subtitle: 'funny',
    projectColor: '#f59e0b',
  },
};

/** Long title that gets truncated. */
export const LongTitle: Story = {
  name: 'Long Title (truncated)',
  args: {
    thread: makeThread({
      title:
        'refactor the entire authentication system to use JWT tokens with refresh token rotation and implement proper CSRF protection across all API endpoints',
      lastAssistantMessage:
        'This is a very long assistant message that should also get truncated because the sidebar has limited width and we need to make sure everything stays on one line.',
    }),
    projectPath: '/home/user/projects/funny',
    isSelected: false,
    gitStatus: makeGitStatus(),
    subtitle: 'my-super-long-project-name-that-overflows',
    projectColor: '#3b82f6',
  },
};

/** Multiple thread items stacked to show a realistic list. */
export const ThreadList: Story = {
  name: 'Thread List (multiple)',
  render: (args) => (
    <div className="space-y-0.5">
      <ThreadItem
        {...args}
        thread={makeThread({
          id: 't1',
          title: 'add the line diff github component to st…',
          lastAssistantMessage: "Now I have the 'DiffStats' c…",
        })}
        isSelected={false}
        gitStatus={makeGitStatus({ threadId: 't1' })}
      />
      <ThreadItem
        {...args}
        thread={makeThread({
          id: 't2',
          status: 'running',
          title: 'cuando estoy haciendo un commit desde …',
          lastAssistantMessage: 'Now let me add the live pro…',
          completedAt: undefined,
          createdAt: new Date(Date.now() - 57 * 60_000).toISOString(),
        })}
        isSelected={false}
        gitStatus={makeGitStatus({ threadId: 't2' })}
      />
      <ThreadItem
        {...args}
        thread={makeThread({
          id: 't3',
          title: 'en toolbar de run command el output deb…',
          lastAssistantMessage: 'Let me query the logs to inv…',
          createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          completedAt: new Date(Date.now() - 58 * 60_000).toISOString(),
        })}
        isSelected={false}
        gitStatus={makeGitStatus({ threadId: 't3' })}
      />
      <ThreadItem
        {...args}
        thread={makeThread({
          id: 't4',
          title: 'pudes revisar esto hilo http://127.0.0.1:51…',
          lastAssistantMessage: 'Encontre la causa. Aqui est…',
          createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
          completedAt: new Date(Date.now() - 118 * 60_000).toISOString(),
        })}
        isSelected={false}
        gitStatus={makeGitStatus({ threadId: 't4' })}
      />
      <ThreadItem
        {...args}
        thread={makeThread({
          id: 't5',
          title: 'npx storybook add @storybook/addon-a…',
          lastAssistantMessage: 'Both addons are installed a…',
          createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
          completedAt: new Date(Date.now() - 178 * 60_000).toISOString(),
        })}
        isSelected={false}
        gitStatus={makeGitStatus({ threadId: 't5' })}
      />
    </div>
  ),
  args: {
    thread: makeThread(),
    projectPath: '/home/user/projects/funny',
    isSelected: false,
    subtitle: 'funny',
    projectColor: '#3b82f6',
    gitStatus: makeGitStatus(),
  },
};
