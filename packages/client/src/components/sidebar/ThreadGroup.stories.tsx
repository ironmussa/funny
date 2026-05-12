import type { GitStatusInfo, Thread } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { History, Zap } from 'lucide-react';

import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';

import { ThreadGroup } from './ThreadGroup';
import { ThreadItem } from './ThreadItem';
import { ViewAllButton } from './ViewAllButton';

// ── Mock factories ───────────────────────────────────────────────

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

// ── Meta ─────────────────────────────────────────────────────────

const meta = {
  title: 'Sidebar/ThreadGroup',
  component: ThreadGroup,
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
} satisfies Meta<typeof ThreadGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Stories ──────────────────────────────────────────────────────

/** Recent threads section with History icon — matches the ACTIVITY sidebar. */
export const RecentThreads: Story = {
  name: 'Recent Threads',
  args: {
    title: 'Recent',
    icon: History,
    children: null,
  },
  render: (args) => (
    <ThreadGroup {...args}>
      <ThreadItem
        thread={makeThread({ id: 't1', title: 'add the line diff github component to st…' })}
        projectPath="/home/user/projects/funny"
        isSelected={false}
        subtitle="funny"
        projectColor="#3b82f6"
        gitStatus={makeGitStatus({ threadId: 't1' })}
        onSelect={() => {}}
      />
      <ThreadItem
        thread={makeThread({
          id: 't2',
          title: 'cuando estoy haciendo un commit desde …',
          lastAssistantMessage: 'Now let me add the live pro…',
          createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          completedAt: new Date(Date.now() - 58 * 60_000).toISOString(),
        })}
        projectPath="/home/user/projects/funny"
        isSelected={false}
        subtitle="funny"
        projectColor="#3b82f6"
        gitStatus={makeGitStatus({ threadId: 't2' })}
        onSelect={() => {}}
      />
      <ThreadItem
        thread={makeThread({
          id: 't3',
          title: 'en toolbar de run command el output deb…',
          lastAssistantMessage: 'Let me query the logs to inv…',
          createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
          completedAt: new Date(Date.now() - 118 * 60_000).toISOString(),
        })}
        projectPath="/home/user/projects/funny"
        isSelected={false}
        subtitle="funny"
        projectColor="#3b82f6"
        gitStatus={makeGitStatus({ threadId: 't3' })}
        onSelect={() => {}}
      />
    </ThreadGroup>
  ),
};

/** Active/running threads with pulsing dot icon and count badge. */
export const ActiveThreads: Story = {
  name: 'Active Threads',
  args: {
    title: 'Active',
    count: 2,
    iconElement: (
      <span className="size-1.5 flex-shrink-0 animate-pulse rounded-full bg-status-info" />
    ),
    children: null,
  },
  render: (args) => (
    <ThreadGroup {...args}>
      <ThreadItem
        thread={makeThread({
          id: 't1',
          status: 'running',
          title: 'refactor authentication module',
          lastAssistantMessage: 'Now let me add the live pro…',
          completedAt: undefined,
          createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
        })}
        projectPath="/home/user/projects/funny"
        isSelected={false}
        subtitle="funny"
        projectColor="#3b82f6"
        gitStatus={makeGitStatus({
          threadId: 't1',
          state: 'dirty',
          dirtyFileCount: 12,
          linesAdded: 340,
          linesDeleted: 45,
        })}
        onSelect={() => {}}
      />
      <ThreadItem
        thread={makeThread({
          id: 't2',
          status: 'running',
          title: 'add dark mode support',
          lastAssistantMessage: 'Installing dependencies…',
          completedAt: undefined,
          createdAt: new Date(Date.now() - 1 * 60_000).toISOString(),
        })}
        projectPath="/home/user/projects/api-server"
        isSelected={false}
        subtitle="api-server"
        projectColor="#ef4444"
        onSelect={() => {}}
      />
    </ThreadGroup>
  ),
};

/** Collapsed by default. */
export const Collapsed: Story = {
  name: 'Collapsed',
  args: {
    title: 'Recent',
    icon: History,
    defaultExpanded: false,
    children: null,
  },
  render: (args) => (
    <ThreadGroup {...args}>
      <ThreadItem
        thread={makeThread({ id: 't1' })}
        projectPath="/home/user/projects/funny"
        isSelected={false}
        subtitle="funny"
        projectColor="#3b82f6"
        gitStatus={makeGitStatus({ threadId: 't1' })}
        onSelect={() => {}}
      />
    </ThreadGroup>
  ),
};

/** With a "View All" button at the bottom. */
export const WithViewAll: Story = {
  name: 'With View All',
  args: {
    title: 'Recent',
    icon: History,
    children: null,
  },
  render: (args) => (
    <ThreadGroup {...args}>
      <ThreadItem
        thread={makeThread({ id: 't1', title: 'add the line diff component' })}
        projectPath="/home/user/projects/funny"
        isSelected={false}
        subtitle="funny"
        projectColor="#3b82f6"
        gitStatus={makeGitStatus({ threadId: 't1' })}
        onSelect={() => {}}
      />
      <ThreadItem
        thread={makeThread({ id: 't2', title: 'fix login redirect issue' })}
        projectPath="/home/user/projects/funny"
        isSelected={false}
        subtitle="funny"
        projectColor="#22c55e"
        gitStatus={makeGitStatus({
          threadId: 't2',
          state: 'pushed',
          dirtyFileCount: 0,
          linesAdded: 0,
          linesDeleted: 0,
        })}
        onSelect={() => {}}
      />
      <ViewAllButton onClick={() => {}} />
    </ThreadGroup>
  ),
};

/** Custom icon (e.g. Zap for a custom section). */
export const CustomIcon: Story = {
  name: 'Custom Icon',
  args: {
    title: 'Automations',
    icon: Zap,
    count: 3,
    children: null,
  },
  render: (args) => (
    <ThreadGroup {...args}>
      <ThreadItem
        thread={makeThread({ id: 't1', title: 'auto: update dependencies', createdBy: 'pipeline' })}
        projectPath="/home/user/projects/funny"
        isSelected={false}
        subtitle="funny"
        projectColor="#f59e0b"
        onSelect={() => {}}
      />
      <ThreadItem
        thread={makeThread({ id: 't2', title: 'auto: run nightly tests', createdBy: 'pipeline' })}
        projectPath="/home/user/projects/api"
        isSelected={false}
        subtitle="api"
        projectColor="#a855f7"
        onSelect={() => {}}
      />
      <ThreadItem
        thread={makeThread({ id: 't3', title: 'auto: sync translations', createdBy: 'pipeline' })}
        projectPath="/home/user/projects/funny"
        isSelected={false}
        subtitle="funny"
        projectColor="#f59e0b"
        onSelect={() => {}}
      />
    </ThreadGroup>
  ),
};

/** Recent threads without project chips (inside a single project view). */
export const RecentWithoutChips: Story = {
  name: 'Recent (no project chips)',
  args: {
    title: 'Recent',
    icon: History,
    children: null,
  },
  render: (args) => (
    <ThreadGroup {...args}>
      <ThreadItem
        thread={makeThread({ id: 't1', title: 'add the line diff github component to st…' })}
        projectPath="/home/user/projects/funny"
        isSelected={false}
        gitStatus={makeGitStatus({ threadId: 't1' })}
        onSelect={() => {}}
      />
      <ThreadItem
        thread={makeThread({
          id: 't2',
          title: 'cuando estoy haciendo un commit desde …',
          lastAssistantMessage: 'Now let me add the live pro…',
          createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          completedAt: new Date(Date.now() - 58 * 60_000).toISOString(),
        })}
        projectPath="/home/user/projects/funny"
        isSelected={false}
        gitStatus={makeGitStatus({ threadId: 't2' })}
        onSelect={() => {}}
      />
      <ThreadItem
        thread={makeThread({
          id: 't3',
          title: 'en toolbar de run command el output deb…',
          lastAssistantMessage: 'Let me query the logs to inv…',
          createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
          completedAt: new Date(Date.now() - 118 * 60_000).toISOString(),
        })}
        projectPath="/home/user/projects/funny"
        isSelected={false}
        gitStatus={makeGitStatus({ threadId: 't3' })}
        onSelect={() => {}}
      />
      <ThreadItem
        thread={makeThread({
          id: 't4',
          title: 'fix: critical login bug',
          lastAssistantMessage: 'Fixed the authentication token refresh logic.',
          createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
          completedAt: new Date(Date.now() - 175 * 60_000).toISOString(),
        })}
        projectPath="/home/user/projects/funny"
        isSelected={false}
        gitStatus={makeGitStatus({
          threadId: 't4',
          state: 'pushed',
          dirtyFileCount: 0,
          linesAdded: 0,
          linesDeleted: 0,
          hasRemoteBranch: true,
        })}
        onSelect={() => {}}
      />
      <ThreadItem
        thread={makeThread({
          id: 't5',
          title: 'npx storybook add @storybook/addon-a…',
          lastAssistantMessage: 'Both addons are installed…',
          createdAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
          completedAt: new Date(Date.now() - 238 * 60_000).toISOString(),
        })}
        projectPath="/home/user/projects/funny"
        isSelected={false}
        gitStatus={makeGitStatus({ threadId: 't5' })}
        onSelect={() => {}}
      />
    </ThreadGroup>
  ),
};

/** Full ACTIVITY section showing both Active and Recent groups stacked. */
export const FullActivitySection: Story = {
  name: 'Full Activity Section',
  args: {
    title: '',
    children: null,
  },
  render: () => (
    <div className="space-y-0">
      <ThreadGroup
        title="Active"
        count={1}
        iconElement={
          <span className="size-1.5 flex-shrink-0 animate-pulse rounded-full bg-status-info" />
        }
      >
        <ThreadItem
          thread={makeThread({
            id: 'r1',
            status: 'running',
            title: 'refactor authentication module',
            lastAssistantMessage: 'Installing the new OAuth provider…',
            completedAt: undefined,
            createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
          })}
          projectPath="/home/user/projects/funny"
          isSelected={false}
          subtitle="funny"
          projectColor="#3b82f6"
          gitStatus={makeGitStatus({
            threadId: 'r1',
            state: 'dirty',
            dirtyFileCount: 8,
            linesAdded: 120,
            linesDeleted: 30,
          })}
          onSelect={() => {}}
        />
      </ThreadGroup>
      <ThreadGroup title="Recent" icon={History}>
        <ThreadItem
          thread={makeThread({
            id: 'c1',
            title: 'add the line diff github component',
            lastAssistantMessage: "Now I have the 'DiffStats' component…",
          })}
          projectPath="/home/user/projects/funny"
          isSelected={false}
          subtitle="funny"
          projectColor="#3b82f6"
          gitStatus={makeGitStatus({ threadId: 'c1' })}
          onSelect={() => {}}
        />
        <ThreadItem
          thread={makeThread({
            id: 'c2',
            title: 'fix login redirect after OAuth',
            lastAssistantMessage: 'The redirect URL was missing the callback path…',
            createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
            completedAt: new Date(Date.now() - 88 * 60_000).toISOString(),
          })}
          projectPath="/home/user/projects/api-server"
          isSelected={false}
          subtitle="api-server"
          projectColor="#ef4444"
          gitStatus={makeGitStatus({
            threadId: 'c2',
            state: 'pushed',
            dirtyFileCount: 0,
            linesAdded: 0,
            linesDeleted: 0,
            hasRemoteBranch: true,
          })}
          onSelect={() => {}}
        />
        <ThreadItem
          thread={makeThread({
            id: 'c3',
            title: 'npx storybook add @storybook/addon-a…',
            lastAssistantMessage: 'Both addons are installed…',
            createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
            completedAt: new Date(Date.now() - 178 * 60_000).toISOString(),
          })}
          projectPath="/home/user/projects/funny"
          isSelected={false}
          subtitle="funny"
          projectColor="#3b82f6"
          gitStatus={makeGitStatus({ threadId: 'c3' })}
          onSelect={() => {}}
        />
        <ViewAllButton onClick={() => {}} />
      </ThreadGroup>
    </div>
  ),
};
