import { useTranslation } from 'react-i18next';
import { PromptInput } from './PromptInput';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';

interface SlideUpPromptProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (
    prompt: string,
    opts: { model: string; mode: string; threadMode?: string; baseBranch?: string },
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
    opts: { model: string; mode: string; threadMode?: string; baseBranch?: string },
    images?: any[]
  ) => {
    await onSubmit(prompt, opts, images);
    onClose();
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="bottom" className="p-0 rounded-t-lg max-h-[60vh]">
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle className="text-sm">
            {t('kanban.addThread', 'Add new thread')}
          </SheetTitle>
          <SheetDescription className="sr-only">
            {t('thread.describeTask', 'Describe the task for the agent')}
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          <PromptInput
            key={projectId}
            onSubmit={handleSubmit}
            loading={loading}
            isNewThread
            projectId={projectId}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
