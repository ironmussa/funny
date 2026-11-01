import type { Thread } from '@funny/shared';
import { Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';

// ── Rename ───────────────────────────────────────────────────────────

export function useRenameThreadDialog(title: string, onRename?: (newTitle: string) => void) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');

  const openDialog = useCallback(() => {
    setValue(title);
    setOpen(true);
  }, [title]);

  const commit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== title && onRename) {
      onRename(trimmed);
    }
    setOpen(false);
  }, [value, title, onRename]);

  return { open, setOpen, value, setValue, openDialog, commit };
}

type RenameDialogState = ReturnType<typeof useRenameThreadDialog>;

export function RenameThreadDialog({
  thread,
  dialog,
}: {
  thread: Thread;
  dialog: RenameDialogState;
}) {
  const { t } = useTranslation();
  const { open, setOpen, value, setValue, commit } = dialog;
  const trimmed = value.trim();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md" data-testid={`thread-rename-dialog-${thread.id}`}>
        <DialogHeader>
          <DialogTitle>{t('sidebar.rename')}</DialogTitle>
        </DialogHeader>
        <Input
          data-testid={`thread-rename-input-${thread.id}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit();
          }}
          autoFocus
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} data-testid="thread-rename-cancel">
            {t('common.cancel')}
          </Button>
          <Button
            onClick={commit}
            disabled={!trimmed || trimmed === thread.title}
            data-testid="thread-rename-confirm"
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Create branch ────────────────────────────────────────────────────

/** Turns free text into a valid-ish git branch name (spaces → dashes, strip the rest). */
function sanitizeBranchName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9\-_/.]/g, '');
}

export function useCreateBranchDialog(threadId: string, projectId: Thread['projectId']) {
  const [open, setOpen] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [loading, setLoading] = useState(false);

  const commit = useCallback(async () => {
    const name = sanitizeBranchName(branchName);
    if (!name || !projectId) return;
    setLoading(true);
    try {
      const result = await api.checkout(projectId, name, 'carry', true, threadId);
      if (result.isErr()) {
        toastError(result.error);
      } else {
        setOpen(false);
        setBranchName('');
      }
    } finally {
      setLoading(false);
    }
  }, [branchName, projectId, threadId]);

  const openDialog = useCallback(() => setOpen(true), []);

  return { open, setOpen, branchName, setBranchName, loading, commit, openDialog };
}

type CreateBranchDialogState = ReturnType<typeof useCreateBranchDialog>;

export function CreateBranchDialog({
  thread,
  dialog,
}: {
  thread: Thread;
  dialog: CreateBranchDialogState;
}) {
  const { t } = useTranslation();
  const { open, setOpen, branchName, setBranchName, loading, commit } = dialog;
  const hasName = !!branchName.trim();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="sm:max-w-md"
        data-testid={`thread-create-branch-dialog-${thread.id}`}
      >
        <DialogHeader>
          <DialogTitle>{t('dialog.createBranchTitle')}</DialogTitle>
        </DialogHeader>
        <Input
          data-testid={`thread-create-branch-input-${thread.id}`}
          placeholder={t('dialog.createBranchPlaceholder')}
          value={branchName}
          onChange={(e) => setBranchName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && hasName) {
              commit();
            }
          }}
          autoFocus
        />
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            data-testid={`thread-create-branch-cancel-${thread.id}`}
          >
            {t('common.cancel')}
          </Button>
          <Button
            onClick={commit}
            disabled={!hasName || loading}
            data-testid={`thread-create-branch-confirm-${thread.id}`}
          >
            {loading ? <Loader2 className="icon-sm animate-spin" /> : t('common.create', 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
