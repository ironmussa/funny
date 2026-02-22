import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { PromptInput } from '../PromptInput';

export function NewThreadInput() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const newThreadProjectId = useAppStore(s => s.newThreadProjectId);
  const selectedProjectId = useAppStore(s => s.selectedProjectId);
  const effectiveProjectId = newThreadProjectId || selectedProjectId;
  const newThreadIdleOnly = useAppStore(s => s.newThreadIdleOnly);
  const cancelNewThread = useAppStore(s => s.cancelNewThread);
  const loadThreadsForProject = useAppStore(s => s.loadThreadsForProject);
  const projects = useProjectStore(s => s.projects);
  const project = effectiveProjectId ? projects.find(p => p.id === effectiveProjectId) : undefined;
  const defaultThreadMode = project?.defaultMode ?? 'worktree';
  const toolPermissions = useSettingsStore(s => s.toolPermissions);

  const [creating, setCreating] = useState(false);

  const handleCreate = async (
    prompt: string,
    opts: { provider?: string; model: string; mode: string; threadMode?: string; baseBranch?: string; sendToBacklog?: boolean; fileReferences?: { path: string }[] },
    images?: any[]
  ): Promise<boolean> => {
    if (!effectiveProjectId || creating) return false;
    setCreating(true);

    const threadMode = (opts.threadMode as 'local' | 'worktree') || defaultThreadMode;

    // If idle-only mode or sendToBacklog toggle, create idle thread without executing
    if (newThreadIdleOnly || opts.sendToBacklog) {
      const result = await api.createIdleThread({
        projectId: effectiveProjectId,
        title: prompt.slice(0, 200),
        mode: threadMode,
        baseBranch: opts.baseBranch,
        prompt,
      });

      if (result.isErr()) {
        toast.error(result.error.message);
        setCreating(false);
        return false;
      }

      await loadThreadsForProject(effectiveProjectId);
      setCreating(false);
      toast.success(t('toast.threadCreated', { title: prompt.slice(0, 200) }));
      cancelNewThread();
      return true;
    }

    // Normal mode: create and execute thread
    const { allowedTools, disallowedTools } = deriveToolLists(toolPermissions);
    const result = await api.createThread({
      projectId: effectiveProjectId,
      title: prompt.slice(0, 200),
      mode: threadMode,
      provider: opts.provider,
      model: opts.model,
      permissionMode: opts.mode,
      baseBranch: opts.baseBranch,
      prompt,
      images,
      allowedTools,
      disallowedTools,
      fileReferences: opts.fileReferences,
    });

    if (result.isErr()) {
      toast.error(result.error.message);
      setCreating(false);
      return false;
    }

    await loadThreadsForProject(effectiveProjectId);
    setCreating(false);
    navigate(`/projects/${effectiveProjectId}/threads/${result.value.id}`);
    return true;
  };

  return (
    <>
      {/* Empty state area */}
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-4xl mb-4">✨</p>
          <p className="text-2xl font-semibold text-foreground">{t('thread.whatShouldAgentDo')}</p>
          <p className="text-sm mt-2">{t('thread.describeTask')}</p>
        </div>
      </div>

      <PromptInput
        key={effectiveProjectId}
        onSubmit={handleCreate}
        loading={creating}
        isNewThread
        showBacklog
        projectId={effectiveProjectId || undefined}
      />
    </>
  );
}
