import type { Meta, StoryObj } from '@storybook/react-vite';
import { okAsync, ResultAsync } from 'neverthrow';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

import { WorktreeDeleteDialog, type WorktreeDeleteTarget } from './WorktreeDeleteDialog';

/* ------------------------------------------------------------------ */
/*  Mock data                                                         */
/* ------------------------------------------------------------------ */

const BASE_TARGET: WorktreeDeleteTarget = {
  threadId: 'thread-1',
  projectId: 'proj-1',
  title: 'Fix authentication bug',
  worktreePath: '/home/user/project/.worktrees/fix-auth-bug',
  branchName: 'fix/auth-bug',
};

function mockStatus(
  overrides: {
    unpushedCommitCount?: number;
    dirtyFileCount?: number;
    hasRemoteBranch?: boolean;
  } = {},
) {
  api.worktreeStatus = () =>
    okAsync({
      unpushedCommitCount: 0,
      dirtyFileCount: 0,
      hasRemoteBranch: true,
      ...overrides,
    });
}

/* ------------------------------------------------------------------ */
/*  Trigger wrapper                                                   */
/* ------------------------------------------------------------------ */

function WorktreeDeleteTrigger({
  target,
  loading,
  label,
  setupMocks,
}: {
  target: WorktreeDeleteTarget;
  loading?: boolean;
  label: string;
  setupMocks: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        data-testid="worktree-delete-trigger"
        onClick={() => {
          setupMocks();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <WorktreeDeleteDialog
        open={open}
        target={target}
        loading={loading}
        onCancel={() => setOpen(false)}
        onConfirm={() => setOpen(false)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta: Meta = {
  title: 'Dialogs/WorktreeDeleteDialog',
  component: WorktreeDeleteDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

/** Clean worktree — no unpushed commits or dirty files. */
export const Clean: Story = {
  render: () => (
    <WorktreeDeleteTrigger
      target={BASE_TARGET}
      label="Delete (clean)"
      setupMocks={() => mockStatus()}
    />
  ),
};

/** Worktree with unpushed commits. */
export const UnpushedCommits: Story = {
  render: () => (
    <WorktreeDeleteTrigger
      target={BASE_TARGET}
      label="Delete (unpushed)"
      setupMocks={() => mockStatus({ unpushedCommitCount: 3 })}
    />
  ),
};

/** Worktree with dirty (uncommitted) files. */
export const DirtyFiles: Story = {
  render: () => (
    <WorktreeDeleteTrigger
      target={BASE_TARGET}
      label="Delete (dirty)"
      setupMocks={() => mockStatus({ dirtyFileCount: 5 })}
    />
  ),
};

/** Both unpushed commits and dirty files. */
export const UnpushedAndDirty: Story = {
  render: () => (
    <WorktreeDeleteTrigger
      target={BASE_TARGET}
      label="Delete (unpushed + dirty)"
      setupMocks={() => mockStatus({ unpushedCommitCount: 2, dirtyFileCount: 7 })}
    />
  ),
};

/** No worktree path — shows generic warning fallback. */
export const NoWorktreePath: Story = {
  render: () => (
    <WorktreeDeleteTrigger
      target={{ ...BASE_TARGET, worktreePath: null, branchName: null }}
      label="Delete (no worktree)"
      setupMocks={() => {}}
    />
  ),
};

/** Long thread title gets truncated. */
export const LongTitle: Story = {
  render: () => (
    <WorktreeDeleteTrigger
      target={{
        ...BASE_TARGET,
        title:
          'Refactor the entire authentication subsystem to use OAuth 2.0 with PKCE flow and migrate all existing sessions to the new token format',
      }}
      label="Delete (long title)"
      setupMocks={() => mockStatus()}
    />
  ),
};

/** Delete in progress (loading state). */
export const Loading: Story = {
  render: () => (
    <WorktreeDeleteTrigger
      target={BASE_TARGET}
      loading
      label="Delete (loading)"
      setupMocks={() => mockStatus()}
    />
  ),
};

/** Status loading state — API takes time to respond. */
export const StatusLoading: Story = {
  render: () => (
    <WorktreeDeleteTrigger
      target={BASE_TARGET}
      label="Delete (status loading)"
      setupMocks={() => {
        api.worktreeStatus = () => new ResultAsync(new Promise(() => {}));
      }}
    />
  ),
};
