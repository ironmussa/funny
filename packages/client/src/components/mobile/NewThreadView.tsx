import { DEFAULT_THREAD_MODE } from '@funny/shared/models';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PromptInput } from '@/components/PromptInput';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { useAppStore } from '@/stores/app-store';

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
  const [creating, setCreating] = useState(false);

  const handleCreate = async (
    prompt: string,
    opts: { model: string; mode: string; threadMode?: string; baseBranch?: string },
    images?: any[],
  ): Promise<boolean> => {
    if (creating) return false;
    setCreating(true);

    const result = await api.createThread({
      projectId,
      title: prompt.slice(0, 200),
      mode: (opts.threadMode as 'local' | 'worktree') || defaultThreadMode,
      model: opts.model,
      permissionMode: opts.mode,
      baseBranch: opts.baseBranch,
      prompt,
      images,
    });

    if (result.isErr()) {
      toastError(result.error);
      setCreating(false);
      return false;
    }

    await loadThreadsForProject(projectId);
    onCreated(result.value.id);
    return true;
  };

  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <button
          onClick={onBack}
          aria-label={t('common.back', 'Back')}
          className="-ml-1 rounded p-1 hover:bg-accent"
        >
          <ArrowLeft className="icon-lg" />
        </button>
        <h1 className="text-base font-semibold">{t('thread.newThread', 'New Thread')}</h1>
      </header>
      <div className="flex flex-1 items-center justify-center p-4 text-muted-foreground">
        <div className="text-center">
          <p className="mb-4 text-4xl">✨</p>
          <p className="text-2xl font-semibold text-foreground">{t('thread.whatShouldAgentDo')}</p>
          <p className="mt-2 text-sm">{t('thread.describeTask')}</p>
        </div>
      </div>
      <PromptInput
        onSubmit={handleCreate}
        loading={creating}
        isNewThread
        showBacklog
        projectId={projectId}
      />
    </>
  );
}
