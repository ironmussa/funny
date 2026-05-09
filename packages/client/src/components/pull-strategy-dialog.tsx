import { GitMerge, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { cn } from '@/lib/utils';

type ReconcileStrategy = Exclude<PullStrategy, 'ff-only'>;

interface PullStrategyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The original pull error message (for display only). */
  errorMessage: string;
  /** Called with the chosen strategy when the user confirms. */
  onChoose: (strategy: ReconcileStrategy) => void;
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
  const [strategy, setStrategy] = useState<ReconcileStrategy>('rebase');

  useEffect(() => {
    if (open) setStrategy('rebase');
  }, [open]);

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

        <div className="mt-2 space-y-2">
          <button
            type="button"
            data-testid="pull-strategy-rebase"
            onClick={() => setStrategy('rebase')}
            className={cn(
              'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
              strategy === 'rebase'
                ? 'border-primary bg-primary/10'
                : 'border-border hover:bg-accent/50',
            )}
          >
            <RotateCcw className="icon-base mt-0.5 shrink-0" />
            <span className="flex flex-col">
              <span className="text-sm font-medium text-foreground">
                {t('review.pullStrategy.rebase', 'Rebase')}
              </span>
              <span className="mt-1.5 text-xs text-muted-foreground">
                {t(
                  'review.pullStrategy.rebaseHint',
                  'Replay your local commits on top of the remote (linear history).',
                )}
              </span>
            </span>
          </button>

          <button
            type="button"
            data-testid="pull-strategy-merge"
            onClick={() => setStrategy('merge')}
            className={cn(
              'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
              strategy === 'merge'
                ? 'border-primary bg-primary/10'
                : 'border-border hover:bg-accent/50',
            )}
          >
            <GitMerge className="icon-base mt-0.5 shrink-0" />
            <span className="flex flex-col">
              <span className="text-sm font-medium text-foreground">
                {t('review.pullStrategy.merge', 'Merge')}
              </span>
              <span className="mt-1.5 text-xs text-muted-foreground">
                {t(
                  'review.pullStrategy.mergeHint',
                  'Create a merge commit that joins both histories.',
                )}
              </span>
            </span>
          </button>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="pull-strategy-cancel"
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => onChoose(strategy)}
            data-testid="pull-strategy-confirm"
          >
            {t('common.confirm', 'Confirm')}
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
