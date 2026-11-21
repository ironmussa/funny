import type { Activity } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';

import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';
import { buildActivity } from '@/data/activities/testing';
import { canRetryActivity } from '@/lib/activity-retry';

import { ActivityList } from './ActivityList';

const NOW = Date.parse('2026-11-20T10:10:00.000Z');

const running = buildActivity({
  id: 'running',
  title: 'Clone acme/widget',
  status: 'running',
  step: 'Cloning',
  startedAt: '2026-11-20T10:09:00.000Z',
});
const failed = buildActivity({
  id: 'failed',
  kind: 'git.workflow',
  title: 'Pushing',
  status: 'failed',
  error: '! [rejected] feat/x -> feat/x (non-fast-forward)',
  projectId: 'p1',
  threadId: 't1',
  input: { action: 'push' },
  endedAt: '2026-11-20T10:07:00.000Z',
});
const interrupted = buildActivity({
  id: 'interrupted',
  kind: 'worktree.setup',
  title: 'Set up worktree app/fix-login',
  status: 'interrupted',
  input: { branch: 'app/fix-login' },
  startedAt: '2026-11-20T09:40:00.000Z',
});
const succeeded = buildActivity({
  id: 'succeeded',
  title: 'Clone acme/api',
  status: 'succeeded',
  resultRef: { projectId: 'p2' },
  endedAt: '2026-11-20T09:30:00.000Z',
});

const meta = {
  title: 'Sidebar/ActivityList',
  component: ActivityList,
  decorators: [
    (Story) => (
      <TooltipProvider>
        <div className="bg-popover w-96 rounded-md border p-1">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
  args: {
    activities: [] as Activity[],
    progress: {},
    runnerOffline: false,
    now: NOW,
    canRetry: canRetryActivity,
    onRetry: () => {},
    onDismiss: () => {},
    onClearFinished: () => {},
  },
} satisfies Meta<typeof ActivityList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {
  args: { activities: [running], progress: { running: 42 } },
};

export const Failed: Story = {
  args: { activities: [failed, succeeded] },
};

export const Interrupted: Story = {
  args: { activities: [interrupted] },
};

export const RunnerOffline: Story = {
  args: { activities: [running], runnerOffline: true },
};

export const Mixed: Story = {
  args: { activities: [running, failed, interrupted, succeeded], progress: { running: 73 } },
};

export const Empty: Story = {
  args: { activities: [] },
};
