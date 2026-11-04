import type { ImageAttachment } from '@funny/shared';
import { useCallback, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';

import type { SubmitFn, SubmitOpts } from './prompt-input-types';
import { usePromptDraft } from './use-prompt-draft';

/**
 * Submit / compact / editor-change handlers for the composer. Callbacks are
 * stable and read the latest thread id + props through refs.
 */
function usePromptInputHandlers({
  editorRef,
  threadIdRef,
  hasSubmittedRef,
  onSubmit,
  clearPromptDraft,
  onContentChange,
}: {
  editorRef: RefObject<PromptEditorHandle | null>;
  threadIdRef: MutableRefObject<string | undefined>;
  hasSubmittedRef: MutableRefObject<boolean>;
  onSubmit: SubmitFn;
  clearPromptDraft: (threadId: string) => void;
  onContentChange?: (hasContent: boolean, text: string) => void;
}) {
  const { t } = useTranslation();

  // ── Editor change handler (for content tracking) ──
  const handleEditorChange = useCallback(() => {
    if (onContentChange) {
      const hasContent = !(editorRef.current?.isEmpty() ?? true);
      const text = editorRef.current?.getText() ?? '';
      onContentChange(hasContent, text);
    }
  }, [editorRef, onContentChange]);

  // Image pasting is handled by PromptInputUI internally
  const handleEditorPaste = useCallback(async (_e: ClipboardEvent) => {
    // no-op — PromptInputUI owns paste handling
  }, []);

  // ── Wrapped onSubmit to track submission for draft ──
  const onSubmitRef = useRef(onSubmit);
  const clearPromptDraftRef = useRef(clearPromptDraft);
  useLayoutEffect(() => {
    onSubmitRef.current = onSubmit;
    clearPromptDraftRef.current = clearPromptDraft;
  }, [clearPromptDraft, onSubmit]);

  const handleCompact = useCallback(async () => {
    const tid = threadIdRef.current;
    if (!tid) return;
    const result = await api.sendMessage(tid, '/compact');
    if (result.isErr()) {
      toastError(result.error);
    } else {
      toast.success(t('prompt.compactRequested', 'Compaction requested'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  const wrappedOnSubmit = useCallback(
    async (prompt: string, opts: SubmitOpts, images?: ImageAttachment[]) => {
      hasSubmittedRef.current = true;
      const tid = threadIdRef.current;
      if (tid) clearPromptDraftRef.current(tid);
      const result = await onSubmitRef.current(prompt, opts, images);
      if (result === false) {
        hasSubmittedRef.current = false;
      }
      return result;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return { handleEditorChange, handleEditorPaste, handleCompact, wrappedOnSubmit };
}

/** Draft persistence + submit/editor handlers for one composer editor. */
export function usePromptEditorSession({
  editorRef,
  effectiveThreadId,
  threadIdRef,
  stopRecordingRef,
  initialPromptProp,
  running,
  loading,
  onSubmit,
  onContentChange,
}: {
  editorRef: RefObject<PromptEditorHandle | null>;
  effectiveThreadId: string | undefined;
  threadIdRef: MutableRefObject<string | undefined>;
  stopRecordingRef: MutableRefObject<() => void>;
  initialPromptProp?: string;
  running: boolean;
  loading: boolean;
  onSubmit: SubmitFn;
  onContentChange?: (hasContent: boolean, text: string) => void;
}) {
  const { hasSubmittedRef, clearPromptDraft } = usePromptDraft({
    editorRef,
    effectiveThreadId,
    threadIdRef,
    stopRecordingRef,
    initialPromptProp,
    running,
    loading,
  });
  return usePromptInputHandlers({
    editorRef,
    threadIdRef,
    hasSubmittedRef,
    onSubmit,
    clearPromptDraft,
    onContentChange,
  });
}
