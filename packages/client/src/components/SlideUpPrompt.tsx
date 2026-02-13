import { useTranslation } from 'react-i18next';
import { PromptInput } from './PromptInput';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

interface SlideUpPromptProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (
    prompt: string,
    opts: { model: string; mode: string; threadMode?: string; baseBranch?: string; sendToBacklog?: boolean },
    images?: any[]
  ) => void;
  loading?: boolean;
  projectId?: string;
}

export function SlideUpPrompt({
  open,
  onClose,
  onSubmit,
  loading = false,
  projectId,
}: SlideUpPromptProps) {
  const { t } = useTranslation();

  const handleSubmit = async (
    prompt: string,
    opts: { model: string; mode: string; threadMode?: string; baseBranch?: string; sendToBacklog?: boolean },
    images?: any[]
  ) => {
    await onSubmit(prompt, opts, images);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-2xl p-0 gap-0">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-sm">
            {t('kanban.addThread', 'Add new thread')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('thread.describeTask', 'Describe the task for the agent')}
          </DialogDescription>
        </DialogHeader>
        <div className="px-4 pb-4">
          <PromptInput
            key={projectId}
            onSubmit={handleSubmit}
            loading={loading}
            isNewThread
            projectId={projectId}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
