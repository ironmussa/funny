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
}: Args) {
  const { t } = useTranslation();
  const loadThreadsForProject = useThreadStore((s) => s.loadThreadsForProject);
  const [savingBacklog, setSavingBacklog] = useState(false);

  const blocker = useNavigationBlock((currentPath, nextPath) => {
    if (justSubmittedRef.current) return false;
    if (currentPath === nextPath) return false;
    return hasContentRef.current;
  });

  const handleSaveToBacklog = useCallback(async () => {
    if (!effectiveProjectId) return;
    const text = latestPromptTextRef.current.trim();
    if (!text) {
      blocker.proceed?.();
      return;
    }
    setSavingBacklog(true);
    try {
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
      blocker.proceed?.();
    } finally {
      setSavingBacklog(false);
    }
  }, [
    effectiveProjectId,
    defaultThreadMode,
    loadThreadsForProject,
    blocker,
    latestPromptTextRef,
    t,
  ]);

  const handleDiscard = useCallback(() => {
    blocker.proceed?.();
  }, [blocker]);

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
