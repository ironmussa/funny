import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { PromptInput } from '../PromptInput';

export function NewThreadInput() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const newThreadProjectId = useAppStore(s => s.newThreadProjectId);
  const newThreadIdleOnly = useAppStore(s => s.newThreadIdleOnly);
  const cancelNewThread = useAppStore(s => s.cancelNewThread);
  const loadThreadsForProject = useAppStore(s => s.loadThreadsForProject);
  const defaultThreadMode = useSettingsStore(s => s.defaultThreadMode);
  const toolPermissions = useSettingsStore(s => s.toolPermissions);

  const [creating, setCreating] = useState(false);

  const handleCreate = async (
    prompt: string,
    opts: { model: string; mode: string; threadMode?: string; baseBranch?: string },
    images?: any[]
  ) => {
    if (!newThreadProjectId || creating) return;
    setCreating(true);

    const threadMode = (opts.threadMode as 'local' | 'worktree') || defaultThreadMode;

    // If idle-only mode, create idle thread without executing
    if (newThreadIdleOnly) {
      const result = await api.createIdleThread({
        projectId: newThreadProjectId,
        title: prompt.slice(0, 200),
        mode: threadMode,
        baseBranch: opts.baseBranch,
        prompt,
      });

      if (result.isErr()) {
        toast.error(result.error.message);
        setCreating(false);
        return;
      }

      await loadThreadsForProject(newThreadProjectId);
      setCreating(false);
      toast.success(t('toast.threadCreated', { title: prompt.slice(0, 200) }));
      cancelNewThread();
      return;
    }

    // Normal mode: create and execute thread
    const { allowedTools, disallowedTools } = deriveToolLists(toolPermissions);
    const result = await api.createThread({
      projectId: newThreadProjectId,
      title: prompt.slice(0, 200),
      mode: threadMode,
      model: opts.model,
      permissionMode: opts.mode,
      baseBranch: opts.baseBranch,
      prompt,
      images,
      allowedTools,
      disallowedTools,
    });

    if (result.isErr()) {
      toast.error(result.error.message);
      setCreating(false);
      return;
    }

    await loadThreadsForProject(newThreadProjectId);
    setCreating(false);
    navigate(`/projects/${newThreadProjectId}/threads/${result.value.id}`);
  };

  return (
    <>
      {/* Empty state area */}
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-sm">{t('thread.whatShouldAgentDo')}</p>
          <p className="text-xs mt-1">{t('thread.describeTask')}</p>
        </div>
      </div>

      <PromptInput
        key={newThreadProjectId}
        onSubmit={handleCreate}
        loading={creating}
        isNewThread
        projectId={newThreadProjectId || undefined}
      />
    </>
  );
}
