import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';
import { useThreadStore } from '@/stores/thread-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { PromptInput } from '../PromptInput';

export function NewThreadInput() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const newThreadProjectId = useUIStore(s => s.newThreadProjectId);
  const selectedProjectId = useProjectStore(s => s.selectedProjectId);
  const effectiveProjectId = newThreadProjectId || selectedProjectId;
  const newThreadIdleOnly = useUIStore(s => s.newThreadIdleOnly);
  const cancelNewThread = useUIStore(s => s.cancelNewThread);
  const loadThreadsForProject = useThreadStore(s => s.loadThreadsForProject);
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

    // Set selectedThreadId immediately so WS events are buffered while activeThread loads.
    // This closes the race condition where the server emits events before the client navigates.
    useThreadStore.setState({ selectedThreadId: result.value.id });
    await loadThreadsForProject(effectiveProjectId);
    setCreating(false);
    navigate(`/projects/${effectiveProjectId}/threads/${result.value.id}`);
    return true;
  };

  return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground px-4">
      <div className="w-full max-w-3xl">
        <PromptInput
          key={effectiveProjectId}
          onSubmit={handleCreate}
          loading={creating}
          isNewThread
          showBacklog
          projectId={effectiveProjectId || undefined}
        />
      </div>
    </div>
  );
}
