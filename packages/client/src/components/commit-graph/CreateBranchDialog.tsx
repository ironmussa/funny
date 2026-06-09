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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Short SHA of the start-point commit, shown in the description for context. */
  shortHash: string;
  /** Called with the entered branch name when the user confirms. */
  onCreate: (name: string) => void;
}

/**
 * Prompt for a new branch name when creating a branch from a commit in the
 * graph ("Create branch from here"). A DropdownMenuItem can't host a text input,
 * so the menu opens this dialog. The name is validated against the same git-ref
 * grammar the server enforces ({@link gitRefSchema}) so invalid input is caught
 * before the request rather than surfacing as a server error toast.
 */
export function CreateBranchDialog({ open, onOpenChange, shortHash, onCreate }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState('');

  // Reset the field each time the dialog opens so a previous, abandoned name
  // doesn't linger when creating a branch from a different commit.
  useEffect(() => {
    if (open) setName('');
  }, [open]);

  const trimmed = name.trim();
  // Mirror of gitRefSchema: valid git-ref chars, no leading dash, non-empty.
  const isValid =
    trimmed.length > 0 && !trimmed.startsWith('-') && /^[A-Za-z0-9._/@^~:{}=-]+$/.test(trimmed);

  const submit = () => {
    if (!isValid) return;
    onCreate(trimmed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('graph.createBranchTitle', 'Create branch')}</DialogTitle>
          <DialogDescription>
            {t('graph.createBranchDesc', {
              hash: shortHash,
              defaultValue: `Create a new branch starting at ${shortHash} and switch to it.`,
            })}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t('graph.createBranchPlaceholder', 'branch name')}
          data-testid="create-branch-name"
        />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="create-branch-cancel"
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={submit} disabled={!isValid} data-testid="create-branch-confirm">
            {t('graph.createBranchConfirm', 'Create branch')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
