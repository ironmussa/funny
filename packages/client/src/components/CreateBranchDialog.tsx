import { GitBranch, Loader2, Sparkles } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface CreateBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The branch the new branch will be based on (shown in description). */
  sourceBranch?: string;
  /** When provided, enables the "Suggest from title" Sparkles button. */
  threadTitle?: string;
  loading?: boolean;
  onCreate: (branchName: string) => void;
}

function sanitizeBranchName(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9\-_/.]/g, '');
}

function suggestSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

export function CreateBranchDialog({
  open,
  onOpenChange,
  sourceBranch,
  threadTitle,
  loading,
  onCreate,
}: CreateBranchDialogProps) {
  const { t } = useTranslation();
  const [branchName, setBranchName] = useState('');

  useEffect(() => {
    if (!open) setBranchName('');
  }, [open]);

  const submit = () => {
    const name = sanitizeBranchName(branchName);
    if (!name) return;
    onCreate(name);
  };

  const canSubmit = !!branchName.trim() && !loading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="create-branch-dialog">
        <DialogHeader>
          <DialogTitle>{t('dialog.createBranchTitle')}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1">
            <span>{t('dialog.createBranchBasedOn', 'Your new branch will be based on')}</span>
            <span className="bg-muted text-foreground inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs">
              <GitBranch className="icon-xs" />
              {sourceBranch || t('dialog.createBranchBasedOnUnknown', 'current branch')}
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            data-testid="create-branch-input"
            placeholder={t('dialog.createBranchPlaceholder')}
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) submit();
            }}
            autoFocus
          />
          {threadTitle && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-testid="create-branch-suggest"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    const slug = suggestSlug(threadTitle);
                    if (slug) setBranchName(slug);
                  }}
                >
                  <Sparkles className="icon-base" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('dialog.suggestBranchName', 'Suggest from title')}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="create-branch-cancel"
          >
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit} data-testid="create-branch-confirm">
            {loading ? (
              <Loader2 className="icon-base animate-spin" />
            ) : (
              t('common.create', 'Create')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
