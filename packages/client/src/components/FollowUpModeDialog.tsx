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

interface FollowUpModeDialogProps {
  open: boolean;
  onInterrupt: () => void;
  onQueue: () => void;
  onCancel: () => void;
}

export function FollowUpModeDialog({
  open,
  onInterrupt,
  onQueue,
  onCancel,
}: FollowUpModeDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="sm:max-w-xs" data-testid="followup-mode-dialog">
        <DialogHeader className="pb-1">
          <DialogTitle className="text-sm">{t('thread.followUpDialogTitle')}</DialogTitle>
          <DialogDescription className="text-xs">
            {t('thread.followUpDialogDesc')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-1.5 sm:flex-col sm:justify-stretch sm:space-x-0">
          <Button
            data-testid="followup-interrupt"
            variant="default"
            size="sm"
            className="w-full"
            onClick={onInterrupt}
          >
            {t('thread.followUpInterrupt')}
          </Button>
          <Button
            data-testid="followup-queue"
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={onQueue}
          >
            {t('thread.followUpQueue')}
          </Button>
          <Button
            data-testid="followup-cancel"
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={onCancel}
          >
            {t('thread.followUpCancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
