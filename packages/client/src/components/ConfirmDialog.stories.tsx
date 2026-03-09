import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/* ------------------------------------------------------------------ */
/*  Generic confirmation dialog wrapper that mirrors the pattern used */
/*  across Sidebar, KanbanView, ProjectHeader, ReviewPane, and        */
/*  WorktreeSettings.                                                 */
/* ------------------------------------------------------------------ */

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  /** Optional warning banner (e.g. worktree deletion warning) */
  warning?: string;
  /** Label for the cancel button */
  cancelLabel?: string;
  /** Label for the confirm button */
  confirmLabel?: string;
  /** Button variant for the confirm action */
  variant?: 'default' | 'destructive';
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDialog({
  open,
  title,
  description,
  warning,
  cancelLabel = 'Cancel',
  confirmLabel = 'Confirm',
  variant = 'destructive',
  loading,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="break-all">{description}</DialogDescription>
        </DialogHeader>
        {warning && (
          <p className="rounded-md bg-status-warning/10 px-3 py-2 text-xs text-status-warning/80">
            {warning}
          </p>
        )}
        <DialogFooter>
          <Button
            data-testid="confirm-dialog-cancel"
            variant="outline"
            size="sm"
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            data-testid="confirm-dialog-confirm"
            variant={variant}
            size="sm"
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta: Meta<typeof ConfirmDialog> = {
  title: 'Components/ConfirmDialog',
  component: ConfirmDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  args: {
    open: true,
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
    const cancelBtn = canvas.getByTestId('confirm-dialog-cancel');
    await userEvent.click(cancelBtn);
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
    const confirmBtn = canvas.getByTestId('confirm-dialog-confirm');
    await userEvent.click(confirmBtn);
    await expect(args.onConfirm).toHaveBeenCalledTimes(1);
    await expect(args.onCancel).not.toHaveBeenCalled();
  },
};
