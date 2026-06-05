import { GitPullRequest, Loader2 } from 'lucide-react';
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

export interface PRDraft {
  title: string;
  body: string;
}

interface Props {
  draft: PRDraft | null;
  threadBranch?: string;
  baseBranch?: string;
  inProgress: boolean;
  onChange: (next: PRDraft | null) => void;
  onSubmit: () => void;
}

/**
 * Modal for composing a new pull request title + body. Extracted from
 * CommitHistoryTab so the parent doesn't import the Dialog cluster, Input,
 * GitPullRequest, or Loader2 just for this one dialog.
 */
export function CreatePRDialog({
  draft,
  threadBranch,
  baseBranch,
  inProgress,
  onChange,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={!!draft}
      onOpenChange={(open) => {
        if (!open) onChange(null);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('review.createPR')}</DialogTitle>
          <DialogDescription>
            {t('review.createPRTooltip', { branch: threadBranch, target: baseBranch || 'base' })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            placeholder={t('review.prTitle', 'PR title')}
            data-testid="history-pr-title"
            value={draft?.title ?? ''}
            onChange={(e) => onChange(draft ? { ...draft, title: e.target.value } : draft)}
          />
          <textarea
            className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring/50 w-full resize-none rounded-md border px-2 py-1.5 text-xs focus-visible:ring-1 focus-visible:outline-hidden"
            rows={4}
            placeholder={t('review.commitBody', 'Description (optional)')}
            data-testid="history-pr-body"
            value={draft?.body ?? ''}
            onChange={(e) => onChange(draft ? { ...draft, body: e.target.value } : draft)}
          />
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onChange(null)}
            data-testid="history-pr-cancel"
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!draft?.title.trim() || inProgress}
            onClick={onSubmit}
            data-testid="history-pr-create"
          >
            {inProgress ? (
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
