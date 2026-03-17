import type { ThreadPurpose } from '@funny/shared';
import { DEFAULT_THREAD_MODE } from '@funny/shared/models';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { PromptInput } from '../PromptInput';

/** Generate a kebab-case arc name from a prompt with a short unique suffix. */
function generateArcName(prompt: string): string {
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32)
      .replace(/-$/, '') || 'unnamed-arc';
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${slug}-${suffix}`;
}

export function NewThreadInput() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const newThreadProjectId = useUIStore((s) => s.newThreadProjectId);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const effectiveProjectId = newThreadProjectId || selectedProjectId;
  const newThreadIdleOnly = useUIStore((s) => s.newThreadIdleOnly);
  const cancelNewThread = useUIStore((s) => s.cancelNewThread);
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const loadThreadsForProject = useThreadStore((s) => s.loadThreadsForProject);
  const projects = useProjectStore((s) => s.projects);
  const project = effectiveProjectId
    ? projects.find((p) => p.id === effectiveProjectId)
    : undefined;
  const defaultThreadMode = project?.defaultMode ?? DEFAULT_THREAD_MODE;
  const toolPermissions = useSettingsStore((s) => s.toolPermissions);

  const [creating, setCreating] = useState(false);

  const handleCreate = async (
    prompt: string,
    opts: {
      provider?: string;
      model: string;
      mode: string;
      threadMode?: string;
      runtime?: string;
      baseBranch?: string;
      sendToBacklog?: boolean;
      fileReferences?: { path: string }[];
      purpose?: ThreadPurpose;
    },
    images?: any[],
  ): Promise<boolean> => {
    if (!effectiveProjectId || creating) return false;
    setCreating(true);

    const purpose = opts.purpose ?? 'implement';
    const isLocalOnlyPurpose = purpose !== 'implement';
    const threadMode = isLocalOnlyPurpose
      ? 'local'
      : (opts.threadMode as 'local' | 'worktree') || defaultThreadMode;

    // Auto-create arc for explore purpose
    let arcId: string | undefined;
    if (purpose === 'explore') {
      const arcName = generateArcName(prompt);
      const arcResult = await api.createArc(effectiveProjectId, arcName);
      if (arcResult.isErr()) {
        toastError(arcResult.error, 'createArc');
        setCreating(false);
        return false;
      }
      arcId = arcResult.value.id;
      // Create arc directory on filesystem
      await api.createArcDirectory(effectiveProjectId, arcName);
    }

    // If idle-only mode or sendToBacklog toggle, create idle thread without executing
    if (newThreadIdleOnly || opts.sendToBacklog) {
      const result = await api.createIdleThread({
        projectId: effectiveProjectId,
        title: prompt.slice(0, 200),
        mode: threadMode,
        baseBranch: opts.baseBranch,
        prompt,
        images,
        arcId,
        purpose,
      });

      if (result.isErr()) {
        toastError(result.error, 'createThread');
        setCreating(false);
        return false;
      }

      await loadThreadsForProject(effectiveProjectId);
      setCreating(false);
      setReviewPaneOpen(false);
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
      runtime: opts.runtime as 'local' | 'remote' | undefined,
      provider: opts.provider,
      model: opts.model,
      permissionMode: isLocalOnlyPurpose ? 'plan' : opts.mode,
      baseBranch: opts.baseBranch,
      prompt,
      images,
      allowedTools,
      disallowedTools,
      fileReferences: opts.fileReferences,
      arcId,
      purpose,
    });

    if (result.isErr()) {
      toastError(result.error, 'createThread');
      setCreating(false);
      return false;
    }

    // Thread created — navigate immediately (worktree setup runs in background)
    useThreadStore.setState({ selectedThreadId: result.value.id });
    await loadThreadsForProject(effectiveProjectId);
    setCreating(false);
    setReviewPaneOpen(false);
    cancelNewThread();
    navigate(buildPath(`/projects/${effectiveProjectId}/threads/${result.value.id}`));
    return true;
  };

  return (
    <div className="flex flex-1 items-center justify-center px-4 text-muted-foreground">
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
