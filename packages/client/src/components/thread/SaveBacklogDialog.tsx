import { Loader2 } from 'lucide-react';
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

interface SaveBacklogDialogProps {
  open: boolean;
  loading?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function SaveBacklogDialog({
  open,
  loading,
  onSave,
  onDiscard,
  onCancel,
}: SaveBacklogDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="sm:max-w-xs" data-testid="save-backlog-dialog">
        <DialogHeader>
          <DialogTitle>{t('saveBacklog.title')}</DialogTitle>
          <DialogDescription>{t('saveBacklog.description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-1.5 sm:flex-col sm:justify-stretch sm:space-x-0">
          <Button
            data-testid="save-backlog-save"
            variant="default"
            size="sm"
            className="w-full"
            onClick={onSave}
            disabled={loading}
          >
            {loading && <Loader2 className="icon-sm mr-1.5 animate-spin" />}
            {t('saveBacklog.save')}
          </Button>
          <Button
            data-testid="save-backlog-discard"
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={onDiscard}
            disabled={loading}
          >
            {t('saveBacklog.discard')}
          </Button>
          <Button
            data-testid="save-backlog-cancel"
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={onCancel}
            disabled={loading}
          >
            {t('saveBacklog.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
