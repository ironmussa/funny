import { DEFAULT_THREAD_MODE } from '@funny/shared/models';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PromptInput } from '@/components/PromptInput';
import { useThreadCreation } from '@/hooks/use-thread-creation';
import { useAppStore } from '@/stores/app-store';
import { useSettingsStore } from '@/stores/settings-store';

interface Props {
  projectId: string;
  onBack: () => void;
  onCreated: (threadId: string) => void;
}

export function NewThreadView({ projectId, onBack, onCreated }: Props) {
  const { t } = useTranslation();
  const loadThreadsForProject = useAppStore((s) => s.loadThreadsForProject);
  const projects = useAppStore((s) => s.projects);
  const project = projects.find((p) => p.id === projectId);
  const defaultThreadMode = project?.defaultMode ?? DEFAULT_THREAD_MODE;
  const toolPermissions = useSettingsStore((s) => s.toolPermissions);

  const { creating, createThread } = useThreadCreation({
    projectId,
    defaultThreadMode,
    toolPermissions,
    onSuccess: async (threadId) => {
      await loadThreadsForProject(projectId);
      onCreated(threadId);
    },
  });

  return (
    <>
      <header className="border-border flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <button
          onClick={onBack}
          aria-label={t('common.back', 'Back')}
          className="hover:bg-accent -ml-1 rounded p-1"
        >
          <ArrowLeft className="icon-lg" />
        </button>
        <h1 className="text-base font-semibold">{t('thread.newThread', 'New Thread')}</h1>
      </header>
      <div className="text-muted-foreground flex flex-1 items-center justify-center p-4">
        <div className="text-center">
          <p className="mb-4 text-4xl">✨</p>
          <p className="text-foreground text-2xl font-semibold">{t('thread.whatShouldAgentDo')}</p>
          <p className="mt-2 text-sm">{t('thread.describeTask')}</p>
        </div>
      </div>
      <PromptInput
        onSubmit={createThread}
        loading={creating}
        isNewThread
        showBacklog
        projectId={projectId}
      />
    </>
  );
}
