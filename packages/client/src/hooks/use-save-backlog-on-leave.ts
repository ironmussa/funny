import { type RefObject, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useNavigationBlock } from '@/hooks/use-navigation-block';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { useThreadStore } from '@/stores/thread-store';

interface Args {
  effectiveProjectId: string | undefined;
  defaultThreadMode: 'local' | 'worktree';
  latestPromptTextRef: RefObject<string>;
  hasContentRef: RefObject<boolean>;
  justSubmittedRef: RefObject<boolean>;
  /**
   * Empties the composer once its prompt left it (discarded or saved to the
   * backlog). The compose form stays mounted under overlays such as Settings,
   * so without it the old text, and this guard, come back on every navigation.
   */
  onDraftLeft: () => void;
}

/**
 * Wires the "save unsaved prompt to backlog when the user navigates away"
 * flow. Returns the blocker (for the SaveBacklogDialog) and the three
 * handlers it dispatches to.
 *
 * Extracted from NewThreadInput so the parent doesn't import
 * useNavigationBlock directly.
 */
export function useSaveBacklogOnLeave({
  effectiveProjectId,
  defaultThreadMode,
  latestPromptTextRef,
  hasContentRef,
  justSubmittedRef,
  onDraftLeft,
}: Args) {
  const { t } = useTranslation();
  const loadThreadsForProject = useThreadStore((s) => s.loadThreadsForProject);
  const [savingBacklog, setSavingBacklog] = useState(false);

  const leaveDraft = useCallback(() => {
    hasContentRef.current = false;
    latestPromptTextRef.current = '';
    onDraftLeft();
  }, [hasContentRef, latestPromptTextRef, onDraftLeft]);

  const blocker = useNavigationBlock((currentPath, nextPath) => {
    if (justSubmittedRef.current) return false;
    if (currentPath === nextPath) return false;
    return hasContentRef.current;
  });

  const handleSaveToBacklog = useCallback(async () => {
    if (!effectiveProjectId) return;
    const text = latestPromptTextRef.current.trim();
    if (!text) {
      leaveDraft();
      blocker.proceed?.();
      return;
    }
    setSavingBacklog(true);
    await (async () => {
      const result = await api.createIdleThread({
        projectId: effectiveProjectId,
        title: text.slice(0, 200),
        mode: defaultThreadMode,
        prompt: text,
      });
      if (result.isErr()) {
        toastError(result.error, 'createThread');
        return;
      }
      await loadThreadsForProject(effectiveProjectId);
      toast.success(t('toast.threadCreated', { title: text.slice(0, 200) }));
      leaveDraft();
      blocker.proceed?.();
    })().finally(() => setSavingBacklog(false));
  }, [
    effectiveProjectId,
    defaultThreadMode,
    loadThreadsForProject,
    blocker,
    latestPromptTextRef,
    leaveDraft,
    t,
  ]);

  const handleDiscard = useCallback(() => {
    leaveDraft();
    blocker.proceed?.();
  }, [blocker, leaveDraft]);

  const handleCancel = useCallback(() => {
    blocker.reset?.();
  }, [blocker]);

  return {
    blocker,
    savingBacklog,
    handleSaveToBacklog,
    handleDiscard,
    handleCancel,
  };
}
