import { AlertTriangle, CheckCircle2, GitBranch, Loader2 } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

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
import { Checkbox } from '@/components/ui/checkbox';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface WorktreeDeleteTarget {
  threadId: string;
  projectId: string;
  title: string;
  worktreePath?: string | null;
  branchName?: string | null;
}

interface WorktreeDeleteDialogProps {
  open: boolean;
  target: WorktreeDeleteTarget | null;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: (options: { deleteBranch: boolean }) => void;
}

interface WorktreeStatus {
  unpushedCommitCount: number;
  dirtyFileCount: number;
  hasRemoteBranch: boolean;
}

export function WorktreeDeleteDialog({
  open,
  target,
  loading,
  onCancel,
  onConfirm,
}: WorktreeDeleteDialogProps) {
  const { t } = useTranslation();
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  // Fetch worktree status when dialog opens
  useEffect(() => {
    if (!open || !target?.worktreePath || !target?.projectId) {
      setStatus(null);
      setDeleteBranch(false);
      return;
    }

    setStatusLoading(true);
    setStatus(null);
    api.worktreeStatus(target.projectId, target.worktreePath).then((result) => {
      result.match(
        (data) => setStatus(data),
        () => setStatus(null),
      );
      setStatusLoading(false);
    });
  }, [open, target?.projectId, target?.worktreePath]);

  const handleConfirm = useCallback(() => {
    onConfirm({ deleteBranch });
  }, [onConfirm, deleteBranch]);

  const truncatedTitle =
    target?.title && target.title.length > 80 ? target.title.slice(0, 80) + '…' : target?.title;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onCancel();
      }}
    >
      <AlertDialogContent className="max-w-sm" data-testid="worktree-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('dialog.deleteThread')}</AlertDialogTitle>
          <AlertDialogDescription className="break-all">
            {t('dialog.deleteThreadDesc', { title: truncatedTitle })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Worktree status section */}
        <div className="space-y-2">
          {statusLoading ? (
            <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('dialog.worktreeStatusLoading')}
            </div>
          ) : status ? (
            <>
              {status.unpushedCommitCount > 0 && (
                <Alert
                  variant="destructive"
                  className="border-status-warning/30 bg-status-warning/10 text-status-warning [&>svg]:text-status-warning"
                >
                  <AlertTriangle className="icon-base" />
                  <AlertDescription className="text-xs">
                    {t('dialog.unpushedCommitsWarning', {
                      count: status.unpushedCommitCount,
                    })}
                  </AlertDescription>
                </Alert>
              )}
              {status.dirtyFileCount > 0 && (
                <Alert
                  variant="destructive"
                  className="border-status-warning/30 bg-status-warning/10 text-status-warning [&>svg]:text-status-warning"
                >
                  <AlertTriangle className="icon-base" />
                  <AlertDescription className="text-xs">
                    {t('dialog.dirtyFilesWarning', { count: status.dirtyFileCount })}
                  </AlertDescription>
                </Alert>
              )}
              {status.unpushedCommitCount === 0 && status.dirtyFileCount === 0 && (
                <div className="flex items-center gap-2 py-1 text-xs text-emerald-500">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {t('dialog.noUnpushedCommits')}
                </div>
              )}
            </>
          ) : (
            // Worktree warning fallback (no status fetched — e.g. no worktreePath)
            <Alert
              variant="destructive"
              className="border-status-warning/30 bg-status-warning/10 text-status-warning [&>svg]:text-status-warning"
            >
              <AlertTriangle className="icon-base" />
              <AlertDescription className="text-xs">{t('dialog.worktreeWarning')}</AlertDescription>
            </Alert>
          )}

          {/* Branch cleanup option */}
          {target?.branchName && (
            <label
              className="flex cursor-pointer items-center gap-2 rounded-md border border-border/50 px-3 py-2"
              data-testid="worktree-delete-branch-checkbox"
            >
              <Checkbox
                checked={deleteBranch}
                onCheckedChange={(v) => setDeleteBranch(v === true)}
              />
              <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs">
                {t('dialog.deleteBranchOption', { branch: target.branchName })}
              </span>
            </label>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="worktree-delete-cancel"
            onClick={onCancel}
            disabled={loading}
          >
            {t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="worktree-delete-confirm"
            className={cn(buttonVariants({ variant: 'destructive' }))}
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading && (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
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
            {t('common.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
