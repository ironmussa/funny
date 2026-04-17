import { GitMerge, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { PullStrategy } from '@/lib/api';

interface PullStrategyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The original pull error message (for display only). */
  errorMessage: string;
  /** Called with the chosen strategy when the user picks one. */
  onChoose: (strategy: Exclude<PullStrategy, 'ff-only'>) => void;
}

/**
 * Shown when a plain `git pull` (fast-forward only) fails because the local
 * branch has diverged from the remote. Mirrors GitHub Desktop's behavior of
 * offering merge vs. rebase.
 */
export function PullStrategyDialog({
  open,
  onOpenChange,
  errorMessage,
  onChoose,
}: PullStrategyDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="pull-strategy-dialog">
        <DialogHeader>
          <DialogTitle>{t('review.pullStrategy.title', 'Branches have diverged')}</DialogTitle>
          <DialogDescription>
            {t(
              'review.pullStrategy.description',
              'Your local branch and the remote both have commits the other doesn\u2019t. Choose how to reconcile them.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/30 p-3 font-mono text-xs text-muted-foreground">
          {errorMessage}
        </div>

        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="default"
            onClick={() => onChoose('rebase')}
            className="justify-start"
            data-testid="pull-strategy-rebase"
          >
            <RotateCcw className="icon-base mr-2" />
            <span className="flex flex-col items-start text-left">
              <span>{t('review.pullStrategy.rebase', 'Rebase')}</span>
              <span className="text-xs font-normal opacity-80">
                {t(
                  'review.pullStrategy.rebaseHint',
                  'Replay your local commits on top of the remote (linear history).',
                )}
              </span>
            </span>
          </Button>

          <Button
            type="button"
            variant="outline"
            onClick={() => onChoose('merge')}
            className="justify-start"
            data-testid="pull-strategy-merge"
          >
            <GitMerge className="icon-base mr-2" />
            <span className="flex flex-col items-start text-left">
              <span>{t('review.pullStrategy.merge', 'Merge')}</span>
              <span className="text-xs font-normal opacity-80">
                {t(
                  'review.pullStrategy.mergeHint',
                  'Create a merge commit that joins both histories.',
                )}
              </span>
            </span>
          </Button>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="pull-strategy-cancel"
          >
            {t('common.cancel', 'Cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Detects whether a pull error message indicates that local and remote have
 * diverged, so we should prompt the user for a strategy instead of just
 * showing the raw error.
 */
export function isDivergedBranchesError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('not possible to fast-forward') ||
    m.includes("can't be fast-forwarded") ||
    m.includes('diverging branches') ||
    m.includes('non-fast-forward')
  );
}
