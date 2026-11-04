import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { seedProjects } from '@/data/projects/testing';
import { useThreadStore } from '@/stores/thread-store';

import { ThreadPickerDialog } from './ThreadPickerDialog';

/* ------------------------------------------------------------------ */
/*  Mock data                                                         */
/* ------------------------------------------------------------------ */

const MOCK_PROJECTS = [
  {
    id: 'proj-1',
    name: 'my-api-server',
    path: '/home/user/projects/api',
    userId: 'u1',
    createdAt: '2026-01-01T00:00:00Z',
    color: '#3b82f6',
  },
  {
    id: 'proj-2',
    name: 'frontend-app',
    path: '/home/user/projects/frontend',
    userId: 'u1',
    createdAt: '2026-02-01T00:00:00Z',
    color: '#10b981',
  },
];

const MOCK_THREADS: Record<string, any[]> = {
  'proj-1': [
    {
      id: 'th-1',
      title: 'Fix authentication bug',
      status: 'completed',
      mode: 'worktree',
      branch: 'fix/auth-bug',
      createdAt: '2026-04-08T10:00:00Z',
      completedAt: '2026-04-08T14:00:00Z',
      archived: false,
    },
    {
      id: 'th-2',
      title: 'Add rate limiting middleware',
      status: 'running',
      mode: 'worktree',
      branch: 'feat/rate-limit',
      createdAt: '2026-04-09T08:00:00Z',
      completedAt: null,
      archived: false,
    },
    {
      id: 'th-3',
      title: 'Refactor database queries',
      status: 'idle',
      mode: 'local',
      branch: null,
      createdAt: '2026-04-07T12:00:00Z',
      completedAt: null,
      archived: false,
    },
  ],
  'proj-2': [
    {
      id: 'th-4',
      title: 'Dark mode support',
      status: 'completed',
      mode: 'worktree',
      branch: 'feat/dark-mode',
      createdAt: '2026-04-06T09:00:00Z',
      completedAt: '2026-04-07T16:00:00Z',
      archived: false,
    },
    {
      id: 'th-5',
      title: 'Improve form validation',
      status: 'error',
      mode: 'local',
      branch: null,
      createdAt: '2026-04-05T11:00:00Z',
      completedAt: null,
      archived: false,
    },
  ],
};

/* ------------------------------------------------------------------ */
/*  Trigger wrapper                                                   */
/* ------------------------------------------------------------------ */

function ThreadPickerTrigger({
  label,
  excludeIds,
  threads,
}: {
  label: string;
  excludeIds?: string[];
  threads?: Record<string, any[]>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        data-testid="thread-picker-trigger"
        onClick={() => {
          seedProjects(MOCK_PROJECTS as any);
          useThreadStore.setState({ threadsByProject: threads ?? MOCK_THREADS } as any);
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <ThreadPickerDialog
        open={open}
        onOpenChange={setOpen}
        onSelect={() => setOpen(false)}
        excludeIds={excludeIds}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta: Meta = {
  title: 'Dialogs/ThreadPickerDialog',
  component: ThreadPickerDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

/** Default — threads grouped by project. */
export const Default: Story = {
  render: () => <ThreadPickerTrigger label="Pick a thread" />,
};

/** With some threads excluded. */
export const WithExclusions: Story = {
  render: () => <ThreadPickerTrigger label="Pick (2 excluded)" excludeIds={['th-1', 'th-4']} />,
};

/** No threads available. */
export const Empty: Story = {
  render: () => (
    <ThreadPickerTrigger label="Pick (empty)" threads={{ 'proj-1': [], 'proj-2': [] }} />
  ),
};
