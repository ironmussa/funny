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

const automaticCleanup = buildActivity({
  id: 'automatic-cleanup',
  kind: 'workspace.cleanup',
  title: 'Clean up worktree feature-login',
  status: 'failed',
  origin: 'implicit',
  error: 'Failed to delete branch feature-login: checked out in another worktree',
  input: { reason: 'thread-archived', branch: 'feature-login', deleteBranch: true },
  effects: [
    { effect: 'command-stopped', target: 'bun run dev' },
    { effect: 'worktree-removed', target: '/home/me/.funny/worktrees/acme/feature-login' },
  ],
  endedAt: '2026-11-20T09:50:00.000Z',
});

const discard = buildActivity({
  id: 'discard',
  kind: 'git.destructive',
  title: 'Discard changes to 3 files',
  status: 'succeeded',
  input: { action: 'discard', paths: ['src/a.ts', 'src/b.ts', 'README.md'] },
  effects: [
    { effect: 'changes-discarded', target: 'src/a.ts' },
    { effect: 'changes-discarded', target: 'src/b.ts' },
    { effect: 'changes-discarded', target: 'README.md' },
    { effect: 'snapshot-saved', target: 'refs/funny/undo/discard' },
  ],
  resultRef: { snapshot: 'refs/funny/undo/discard' },
  endedAt: '2026-11-20T09:55:00.000Z',
});

const NO_ACTIVITIES: Activity[] = [];

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
    activities: NO_ACTIVITIES,
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

export const AutomaticCleanup: Story = {
  args: { activities: [automaticCleanup, succeeded] },
};

export const RestorableDiscard: Story = {
  args: { activities: [discard, succeeded], canRestore: (a) => a.id === 'discard' },
};
