import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { gitApi } from '@/lib/api/git';
import { useDraftStore } from '@/stores/draft-store';
import { useProjectStore } from '@/stores/project-store';
import { useReviewPaneStore } from '@/stores/review-pane-store';
import { useThreadStore } from '@/stores/thread-store';

interface UseGenerateCommitMsgArgs {
  hasGitContext: boolean;
  draftId: string | null | undefined;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  setCommitTitle: (v: string) => void;
  setCommitBody: (v: string) => void;
}

export interface UseGenerateCommitMsgResult {
  /** True while an AI generate request is in flight for the current draft. */
  generatingMsg: boolean;
  /** Trigger generation. Aborts any prior in-flight request for the same draft. */
  handleGenerateCommitMsg: () => Promise<void>;
  /** Abort any in-flight generation (called from the parent's git-context reset). */
  abortGenerate: () => void;
}

/**
 * AI commit-message generation. Captures the draft id at invocation time so
 * the result always writes to the correct thread/project even if the user
 * switches away during the await.
 *
 * Extracted from ReviewPane.tsx as part of the god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
export function useGenerateCommitMsg({
  hasGitContext,
  draftId,
  effectiveThreadId,
  projectModeId,
  setCommitTitle,
  setCommitBody,
}: UseGenerateCommitMsgArgs): UseGenerateCommitMsgResult {
  const { t } = useTranslation();
  const generatingMsg = useReviewPaneStore((s) =>
    draftId ? (s.generatingCommitMsg[draftId] ?? false) : false,
  );
  const setGeneratingCommitMsg = useReviewPaneStore((s) => s.setGeneratingCommitMsg);
  const generateAbortRef = useRef<AbortController | null>(null);

  const handleGenerateCommitMsg = useCallback(async () => {
    if (!hasGitContext || generatingMsg) return;

    // Capture identity at invocation time so the result always writes to the
    // correct thread/project, even if the user switches away during the await.
    const capturedDraftId = draftId;
    const capturedThreadId = effectiveThreadId;
    const capturedProjectModeId = projectModeId;
    if (!capturedDraftId) return;

    // Abort any previous in-flight generation for this draft
    generateAbortRef.current?.abort();
    const ac = new AbortController();
    generateAbortRef.current = ac;

    setGeneratingCommitMsg(capturedDraftId, true);
    await (async () => {
      const result = capturedThreadId
        ? await gitApi.generateCommitMessage(capturedThreadId, true, ac.signal)
        : await gitApi.projectGenerateCommitMessage(capturedProjectModeId!, true, ac.signal);

      if (ac.signal.aborted) return;

      if (result.isOk()) {
        // Always persist to the draft store with the captured ID
        useDraftStore
          .getState()
          .setCommitDraft(capturedDraftId, result.value.title, result.value.body);
        // Only update local state if the user is still on the same thread/project
        const currentDraftId =
          useThreadStore.getState().selectedThreadId ||
          useProjectStore.getState().selectedProjectId;
        if (currentDraftId === capturedDraftId) {
          setCommitTitle(result.value.title);
          setCommitBody(result.value.body);
        }
      } else if (!ac.signal.aborted) {
        toast.error(t('review.generateFailed', { message: result.error.message }));
      }
    })().finally(() => {
      setGeneratingCommitMsg(capturedDraftId, false);
      if (generateAbortRef.current === ac) {
        generateAbortRef.current = null;
      }
    });
  }, [
    hasGitContext,
    generatingMsg,
    draftId,
    effectiveThreadId,
    projectModeId,
    setGeneratingCommitMsg,
    setCommitTitle,
    setCommitBody,
    t,
  ]);

  const abortGenerate = useCallback(() => {
    generateAbortRef.current?.abort();
  }, []);

  return { generatingMsg, handleGenerateCommitMsg, abortGenerate };
}
