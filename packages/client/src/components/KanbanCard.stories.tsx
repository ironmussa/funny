import type { GitStatusInfo, Thread } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuthStore } from '@/stores/auth-store';

import { KanbanCard } from './KanbanView';

// ── Helpers ──────────────────────────────────────────────────────

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    projectId: 'proj-1',
    userId: 'user-1',
    title: 'Refactor authentication module to use OAuth2',
    mode: 'worktree',
    status: 'completed',
    stage: 'done',
    provider: 'claude',
    permissionMode: 'autoEdit',
    model: 'sonnet',
    branch: 'feat/auth-refactor',
    baseBranch: 'master',
    cost: 0.127,
    runtime: 'local',
    source: 'web',
    purpose: 'implement',
    createdAt: new Date(Date.now() - 57 * 60_000).toISOString(),
    completedAt: new Date(Date.now() - 55 * 60_000).toISOString(),
    ...overrides,
  };
}

function makeGitStatus(overrides: Partial<GitStatusInfo> = {}): GitStatusInfo {
  return {
    threadId: 'thread-1',
    branchKey: 'proj-1:feat/auth-refactor',
    state: 'dirty',
    dirtyFileCount: 12,
    unpushedCommitCount: 0,
    hasRemoteBranch: false,
    isMergedIntoBase: false,
    linesAdded: 340,
    linesDeleted: 87,
    ...overrides,
  };
}

function seedAuth(displayName = 'Admin User') {
  useAuthStore.setState({
    user: { id: 'user-1', username: 'admin', displayName, role: 'admin' },
    isAuthenticated: true,
    isLoading: false,
    activeOrgId: null,
    activeOrgName: null,
    activeOrgSlug: null,
  });
}

// ── Meta ─────────────────────────────────────────────────────────

const meta = {
  title: 'Components/KanbanCard',
  component: KanbanCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => {
      seedAuth();
      return (
        <MemoryRouter>
          <TooltipProvider>
            <div className="w-72">
              <Story />
            </div>
          </TooltipProvider>
        </MemoryRouter>
      );
    },
  ],
  args: {
    onDelete: () => {},
    stage: 'in_progress',
  },
} satisfies Meta<typeof KanbanCard>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Stories ──────────────────────────────────────────────────────

export const Default: Story = {
  args: {
    thread: makeThread(),
    stage: 'done',
  },
};

export const Running: Story = {
  args: {
    thread: makeThread({
      id: 'thread-running',
      status: 'running',
      title: 'Add dark mode support to the settings panel',
      completedAt: undefined,
      createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    }),
    stage: 'in_progress',
  },
};

export const Failed: Story = {
  args: {
    thread: makeThread({
      id: 'thread-failed',
      status: 'failed',
      title: 'Upgrade dependencies to latest versions',
      completedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    }),
    stage: 'in_progress',
  },
};

export const Idle: Story = {
  name: 'Idle (Backlog)',
  args: {
    thread: makeThread({
      id: 'thread-idle',
      status: 'idle',
      title: 'Investigate slow queries in the dashboard API',
      stage: 'backlog',
      completedAt: undefined,
      cost: 0,
    }),
    stage: 'backlog',
  },
};

export const WithProjectChip: Story = {
  name: 'With Project Chip',
  args: {
    thread: makeThread({ id: 'thread-proj' }),
    projectInfo: { name: 'funny', color: '#3b82f6' },
    stage: 'done',
  },
};

export const WithGitStatus: Story = {
  name: 'With Git Stats',
  args: {
    thread: makeThread({ id: 'thread-git' }),
    projectInfo: { name: 'api-server', color: '#ef4444' },
    gitStatus: makeGitStatus(),
    stage: 'review',
  },
};

export const Pinned: Story = {
  args: {
    thread: makeThread({ id: 'thread-pinned', pinned: true }),
    stage: 'in_progress',
  },
};

export const Ghost: Story = {
  name: 'Ghost (Archived)',
  args: {
    thread: makeThread({
      id: 'thread-archived',
      archived: true,
      title: 'Old migration script cleanup',
    }),
    ghost: true,
    stage: 'archived',
  },
};

export const Highlighted: Story = {
  args: {
    thread: makeThread({ id: 'thread-hl' }),
    highlighted: true,
    stage: 'review',
  },
};

export const WithSearchHighlight: Story = {
  name: 'With Search Highlight',
  args: {
    thread: makeThread({
      id: 'thread-search',
      title: 'Refactor authentication module to use OAuth2',
    }),
    search: 'auth',
    stage: 'done',
  },
};

export const WithContentSnippet: Story = {
  name: 'With Content Snippet',
  args: {
    thread: makeThread({
      id: 'thread-snippet',
      title: 'Add WebSocket reconnection logic',
    }),
    search: 'reconnect',
    contentSnippet: '…implementing exponential backoff for reconnect attempts…',
    stage: 'in_progress',
  },
};

export const AutomationSource: Story = {
  name: 'Automation Source',
  args: {
    thread: makeThread({
      id: 'thread-auto',
      source: 'automation',
      createdBy: 'automation',
      title: 'Nightly lint and type-check run',
      cost: 0.042,
    }),
    stage: 'done',
  },
};

export const ChromeExtensionSource: Story = {
  name: 'Chrome Extension Source',
  args: {
    thread: makeThread({
      id: 'thread-chrome',
      source: 'chrome_extension',
      title: 'Fix CSS overflow on mobile viewport',
    }),
    stage: 'in_progress',
  },
};

export const LongTitle: Story = {
  name: 'Long Title (Clamped)',
  args: {
    thread: makeThread({
      id: 'thread-long',
      title:
        'Implement comprehensive end-to-end testing suite for the entire authentication flow including OAuth2 providers, session management, token refresh, and multi-factor authentication',
    }),
    projectInfo: { name: 'design-system', color: '#a855f7' },
    stage: 'planning',
  },
};

export const ZeroCost: Story = {
  name: 'Zero Cost',
  args: {
    thread: makeThread({
      id: 'thread-zero',
      status: 'idle',
      cost: 0,
      completedAt: undefined,
    }),
    stage: 'backlog',
  },
};

export const LocalMode: Story = {
  name: 'Local Mode (No Branch)',
  args: {
    thread: makeThread({
      id: 'thread-local',
      mode: 'local',
      branch: undefined,
      baseBranch: undefined,
      title: 'Quick fix: typo in README',
      cost: 0.003,
    }),
    stage: 'done',
  },
};
