import { GitMerge, GitPullRequest, Loader2 } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface CreatePRDialogProps {
  prDialog: { title: string; body: string } | null;
  setPrDialog: Dispatch<SetStateAction<{ title: string; body: string } | null>>;
  threadBranch: string | undefined;
  baseBranch: string | undefined;
  prInProgress: boolean;
  handleCreatePROnly: () => void;
}

/**
 * Modal that captures PR title + body before kicking off a `create-pr` workflow.
 *
 * Extracted from ReviewPane.tsx as part of the god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
export function CreatePRDialog({
  prDialog,
  setPrDialog,
  threadBranch,
  baseBranch,
  prInProgress,
  handleCreatePROnly,
}: CreatePRDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={!!prDialog}
      onOpenChange={(open) => {
        if (!open) setPrDialog(null);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('review.createPR')}</DialogTitle>
          <DialogDescription>
            {t('review.createPRTooltip', {
              branch: threadBranch,
              target: baseBranch || 'base',
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            placeholder={t('review.prTitle', 'PR title')}
            data-testid="review-pr-title"
            value={prDialog?.title ?? ''}
            onChange={(e) =>
              setPrDialog((prev) => (prev ? { ...prev, title: e.target.value } : prev))
            }
          />
          <textarea
            className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring/50 w-full resize-none rounded-md border px-2 py-1.5 text-xs focus-visible:ring-1 focus-visible:outline-hidden"
            rows={4}
            placeholder={t('review.commitBody', 'Description (optional)')}
            data-testid="review-pr-body"
            value={prDialog?.body ?? ''}
            onChange={(e) =>
              setPrDialog((prev) => (prev ? { ...prev, body: e.target.value } : prev))
            }
          />
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPrDialog(null)}
            data-testid="review-pr-cancel"
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!prDialog?.title.trim() || prInProgress}
            onClick={handleCreatePROnly}
            data-testid="review-pr-create"
          >
            {prInProgress ? (
              <Loader2 className="icon-sm mr-1.5 animate-spin" />
            ) : (
              <GitPullRequest className="icon-sm mr-1.5" />
            )}
            {t('review.createPR')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface MergeBranchDialogProps {
  mergeDialog: { targetBranch: string; branches: string[]; loading: boolean } | null;
  setMergeDialog: Dispatch<
    SetStateAction<{ targetBranch: string; branches: string[]; loading: boolean } | null>
  >;
  currentBranch: string | undefined;
  mergeInProgress: boolean;
  handleMergeWithTarget: () => void;
}

/**
 * Modal that lists candidate target branches and confirms the merge before
 * kicking off a `merge` workflow.
 */
export function MergeBranchDialog({
  mergeDialog,
  setMergeDialog,
  currentBranch,
  mergeInProgress,
  handleMergeWithTarget,
}: MergeBranchDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={!!mergeDialog}
      onOpenChange={(open) => {
        if (!open) setMergeDialog(null);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t('review.mergeIntoBranch', { target: '', defaultValue: 'Merge into branch' })}
          </DialogTitle>
          <DialogDescription>
            {t('review.mergeDescription', {
              source: currentBranch,
              defaultValue: `Merge ${currentBranch} into the selected target branch.`,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-muted-foreground text-xs font-medium">
            {t('review.targetBranch', 'Target branch')}
          </label>
          {mergeDialog?.loading ? (
            <div className="text-muted-foreground flex items-center gap-2 py-2 text-xs">
              <Loader2 className="icon-sm animate-spin" />
              {t('common.loading', 'Loading...')}
            </div>
          ) : (
            <Select
              value={mergeDialog?.targetBranch}
              onValueChange={(v) =>
                setMergeDialog((prev) => (prev ? { ...prev, targetBranch: v } : null))
              }
            >
              <SelectTrigger className="h-8 text-xs" data-testid="review-merge-target-select">
                <SelectValue placeholder={t('review.selectBranch', 'Select branch')} />
              </SelectTrigger>
              <SelectContent>
                {mergeDialog?.branches.map((b) => (
                  <SelectItem key={b} value={b} className="text-xs">
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMergeDialog(null)}
            data-testid="review-merge-cancel"
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!mergeDialog?.targetBranch || mergeDialog?.loading || mergeInProgress}
            onClick={handleMergeWithTarget}
            data-testid="review-merge-confirm"
          >
            {mergeInProgress ? (
              <Loader2 className="icon-sm mr-1.5 animate-spin" />
            ) : (
              <GitMerge className="icon-sm mr-1.5" />
            )}
            {t('review.merge', 'Merge')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
