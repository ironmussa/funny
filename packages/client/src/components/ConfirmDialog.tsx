import { AlertTriangle } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
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

export function ConfirmDialog({
  open,
  onOpenChange,
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
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className="break-all">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {warning && (
          <Alert
            variant="destructive"
            className="border-status-warning/30 bg-status-warning/10 text-status-warning [&>svg]:text-status-warning"
          >
            <AlertTriangle className="icon-base" />
            <AlertDescription className="text-xs">{warning}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="confirm-dialog-cancel"
            onClick={onCancel}
            disabled={loading}
          >
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="confirm-dialog-confirm"
            className={cn(buttonVariants({ variant }))}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading && (
              <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
