import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, within } from 'storybook/test';

import { ConfirmDialog, type ConfirmDialogProps } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';

type TriggerProps = Omit<ConfirmDialogProps, 'open' | 'onOpenChange'>;

function ConfirmDialogTrigger(args: TriggerProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" data-testid="confirm-dialog-trigger" onClick={() => setOpen(true)}>
        Open dialog
      </Button>
      <ConfirmDialog
        {...args}
        open={open}
        onOpenChange={setOpen}
        onCancel={() => {
          setOpen(false);
          args.onCancel();
        }}
        onConfirm={() => {
          setOpen(false);
          args.onConfirm();
        }}
      />
    </>
  );
}

const meta: Meta<typeof ConfirmDialogTrigger> = {
  title: 'Dialogs/ConfirmDialog',
  component: ConfirmDialogTrigger,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  args: {
    title: 'Confirm action',
    description: 'Are you sure you want to proceed?',
    cancelLabel: 'Cancel',
    confirmLabel: 'Confirm',
    variant: 'destructive',
    loading: false,
    onCancel: fn(),
    onConfirm: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

/* ------------------------------------------------------------------ */
/*  Stories — Delete Thread                                           */
/* ------------------------------------------------------------------ */

/** Delete thread confirmation as used in Sidebar, KanbanView, and ProjectHeader. */
export const DeleteThread: Story = {
  args: {
    title: 'Delete thread',
    description:
      'Are you sure you want to delete "Fix authentication bug"? This action cannot be undone.',
    confirmLabel: 'Delete',
  },
};

/** Delete thread with worktree warning banner. */
export const DeleteThreadWorktree: Story = {
  args: {
    title: 'Delete thread',
    description:
      'Are you sure you want to delete "Add dark mode support"? This action cannot be undone.',
    confirmLabel: 'Delete',
    warning:
      'This thread has a worktree. The branch and worktree will be deleted. Any commits not pushed or merged will be lost.',
  },
};

/* ------------------------------------------------------------------ */
/*  Stories — Archive Thread                                          */
/* ------------------------------------------------------------------ */

/** Archive thread confirmation as used in Sidebar. */
export const ArchiveThread: Story = {
  args: {
    title: 'Archive thread',
    description:
      'Are you sure you want to archive "Refactor database queries"? You can restore it later from Settings.',
    confirmLabel: 'Archive',
    variant: 'default',
  },
};

/** Archive thread with worktree warning. */
export const ArchiveThreadWorktree: Story = {
  args: {
    title: 'Archive thread',
    description:
      'Are you sure you want to archive "Add user notifications"? You can restore it later from Settings.',
    confirmLabel: 'Archive',
    variant: 'default',
    warning:
      'This thread has a worktree. The branch and worktree will be deleted. Any commits not pushed or merged will be lost.',
  },
};

/* ------------------------------------------------------------------ */
/*  Stories — Delete Project                                          */
/* ------------------------------------------------------------------ */

/** Delete project confirmation as used in Sidebar. */
export const DeleteProject: Story = {
  args: {
    title: 'Delete project',
    description:
      'Are you sure you want to delete "my-api-server"? All threads in this project will also be deleted.',
    confirmLabel: 'Delete',
  },
};

/* ------------------------------------------------------------------ */
/*  Stories — Delete Worktree                                         */
/* ------------------------------------------------------------------ */

/** Delete worktree confirmation as used in WorktreeSettings. */
export const DeleteWorktree: Story = {
  args: {
    title: 'Delete worktree',
    description: 'Are you sure you want to remove the worktree for branch "feature/dark-mode"?',
    confirmLabel: 'Delete',
  },
};

/* ------------------------------------------------------------------ */
/*  Stories — Remove Runner                                           */
/* ------------------------------------------------------------------ */

/** Remove runner confirmation as used in RunnersSettings (Settings > Runners). */
export const RemoveRunner: Story = {
  args: {
    title: 'Remove runner',
    description:
      'Are you sure you want to remove "argenisleon-ASUS-Vivobook-S-14-M5406WA-M5406WA-funny"? This action cannot be undone.',
    confirmLabel: 'Remove',
  },
};

/* ------------------------------------------------------------------ */
/*  Stories — Discard / Revert Changes                                */
/* ------------------------------------------------------------------ */

/** Discard changes for a single file as used in ReviewPane. */
export const DiscardFileChanges: Story = {
  args: {
    title: 'Discard changes',
    description: 'Revert all changes to "src/components/Sidebar.tsx"? This cannot be undone.',
    confirmLabel: 'Confirm',
  },
};

/** Discard changes for multiple files as used in ReviewPane. */
export const DiscardAllChanges: Story = {
  args: {
    title: 'Discard changes',
    description: 'Discard changes in 5 file(s)? This cannot be undone.',
    confirmLabel: 'Confirm',
  },
};

/** Undo last commit (soft reset) as used in ReviewPane. */
export const UndoLastCommit: Story = {
  args: {
    title: 'Undo last commit',
    description: 'Undo the last commit? Changes will be kept.',
    confirmLabel: 'Confirm',
  },
};

/* ------------------------------------------------------------------ */
/*  Stories — Edge cases                                              */
/* ------------------------------------------------------------------ */

/** Long title that gets truncated. */
export const LongDescription: Story = {
  args: {
    title: 'Delete thread',
    description:
      'Are you sure you want to delete "Refactor the entire authentication subsystem to use OAuth 2.0 with PKCE flow and migrate all existing sessions…"? This action cannot be undone.',
    confirmLabel: 'Delete',
  },
};

/** Confirm button in loading state. */
export const Loading: Story = {
  args: {
    title: 'Delete thread',
    description:
      'Are you sure you want to delete "Clean up unused imports"? This action cannot be undone.',
    confirmLabel: 'Delete',
    loading: true,
  },
};

/* ------------------------------------------------------------------ */
/*  Interaction tests                                                 */
/* ------------------------------------------------------------------ */

export const ClickCancel: Story = {
  args: {
    title: 'Delete thread',
    description: 'Are you sure?',
    confirmLabel: 'Delete',
  },
  play: async ({ args, canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByTestId('confirm-dialog-trigger'));
    await userEvent.click(canvas.getByTestId('confirm-dialog-cancel'));
    await expect(args.onCancel).toHaveBeenCalledTimes(1);
    await expect(args.onConfirm).not.toHaveBeenCalled();
  },
};

export const ClickConfirm: Story = {
  args: {
    title: 'Delete thread',
    description: 'Are you sure?',
    confirmLabel: 'Delete',
  },
  play: async ({ args, canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByTestId('confirm-dialog-trigger'));
    await userEvent.click(canvas.getByTestId('confirm-dialog-confirm'));
    await expect(args.onConfirm).toHaveBeenCalledTimes(1);
    await expect(args.onCancel).not.toHaveBeenCalled();
  },
};
