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

interface GitInitDialogProps {
  open: boolean;
  path: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function GitInitDialog({ open, path, onOpenChange, onConfirm }: GitInitDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('confirm.gitInitTitle', { defaultValue: 'Initialize Git Repository' })}
          </DialogTitle>
          <DialogDescription>{t('confirm.notGitRepo', { path })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            data-testid="git-init-cancel"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button data-testid="git-init-confirm" onClick={onConfirm}>
            {t('confirm.gitInitAction', { defaultValue: 'Initialize' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
