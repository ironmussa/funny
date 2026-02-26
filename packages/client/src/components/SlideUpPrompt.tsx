import { useTranslation } from 'react-i18next';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

import { PromptInput } from './PromptInput';

interface SlideUpPromptProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (
    prompt: string,
    opts: {
      model: string;
      mode: string;
      threadMode?: string;
      baseBranch?: string;
      sendToBacklog?: boolean;
    },
    images?: any[],
  ) => Promise<boolean | void> | boolean | void;
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
    opts: {
      model: string;
      mode: string;
      threadMode?: string;
      baseBranch?: string;
      sendToBacklog?: boolean;
    },
    images?: any[],
  ): Promise<boolean> => {
    const result = await onSubmit(prompt, opts, images);
    if (result === false) return false;
    onClose();
    return true;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="px-4 pb-2 pt-4">
          <DialogTitle className="text-sm">{t('kanban.addThread', 'Add new thread')}</DialogTitle>
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
