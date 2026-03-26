import { GitBranch, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface SwitchBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentBranch: string;
  targetBranch: string;
  loading?: boolean;
  onSwitch: (strategy: 'stash' | 'carry') => void;
  onCancel: () => void;
}

export function SwitchBranchDialog({
  open,
  onOpenChange,
  currentBranch,
  targetBranch,
  loading,
  onSwitch,
  onCancel,
}: SwitchBranchDialogProps) {
  const { t } = useTranslation();
  const [strategy, setStrategy] = useState<'stash' | 'carry'>('stash');

  const truncate = (s: string, max = 40) => (s.length > max ? s.slice(0, max) + '\u2026' : s);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !loading) onCancel();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-md" data-testid="switch-branch-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="icon-base" />
            {t('switchBranch.title', 'Switch branch')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'switchBranch.description',
              'You have changes on this branch. What would you like to do with them?',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-2">
          {/* Option 1: Stash (leave changes on current branch) */}
          <button
            type="button"
            data-testid="switch-branch-stash"
            disabled={loading}
            onClick={() => setStrategy('stash')}
            className={cn(
              'w-full rounded-lg border p-3 text-left transition-colors',
              strategy === 'stash'
                ? 'border-primary bg-primary/10'
                : 'border-border hover:bg-accent/50',
              loading && 'cursor-not-allowed opacity-60',
            )}
          >
            <p className="text-sm font-medium text-foreground">
              {t('switchBranch.leaveChanges', {
                branch: truncate(currentBranch),
                defaultValue: `Leave my changes on ${truncate(currentBranch)}`,
              })}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t(
                'switchBranch.leaveChangesDesc',
                'Your in-progress work will be stashed on this branch for you to return to later',
              )}
            </p>
          </button>

          {/* Option 2: Carry (bring changes to target branch) */}
          <button
            type="button"
            data-testid="switch-branch-carry"
            disabled={loading}
            onClick={() => setStrategy('carry')}
            className={cn(
              'w-full rounded-lg border p-3 text-left transition-colors',
              strategy === 'carry'
                ? 'border-primary bg-primary/10'
                : 'border-border hover:bg-accent/50',
              loading && 'cursor-not-allowed opacity-60',
            )}
          >
            <p className="text-sm font-medium text-foreground">
              {t('switchBranch.bringChanges', {
                branch: truncate(targetBranch),
                defaultValue: `Bring my changes to ${truncate(targetBranch)}`,
              })}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t(
                'switchBranch.bringChangesDesc',
                'Your in-progress work will follow you to the new branch',
              )}
            </p>
          </button>
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={loading}
            data-testid="switch-branch-cancel"
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => onSwitch(strategy)}
            disabled={loading}
            data-testid="switch-branch-confirm"
          >
            {loading && <Loader2 className="icon-sm mr-1.5 animate-spin" />}
            {t('switchBranch.switchButton', 'Switch branch')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
