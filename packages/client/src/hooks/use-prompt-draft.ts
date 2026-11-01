import type { ImageAttachment } from '@funny/shared';
import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { useDraftStore } from '@/stores/draft-store';

type Draft = ReturnType<typeof useDraftStore.getState>['drafts'][string];

/** Content to load into the editor for a thread: saved draft, then initial prompt. */
function pickDraftContent(draft: Draft | undefined, initialPrompt: string | undefined) {
  return draft?.editorContent || draft?.prompt || initialPrompt || undefined;
}

/** Saves the previous thread's editor draft and loads the next thread's. */
function swapDraftOnThreadChange(
  editor: PromptEditorHandle | null,
  prevId: string | null | undefined,
  nextId: string | undefined,
  saveDraft: (threadId: string, editor: PromptEditorHandle | null) => void,
  initialPrompt: string | undefined,
) {
  if (prevId && prevId !== nextId) saveDraft(prevId, editor);

  if (nextId && nextId !== prevId) {
    const content = pickDraftContent(useDraftStore.getState().drafts[nextId], initialPrompt);
    if (content) editor?.setContent(content);
    else editor?.clear();
  } else if (!nextId && prevId) {
    editor?.clear();
  }
}

/** Re-focuses the editor on thread switch and whenever the agent goes idle. */
function useEditorAutoFocus(
  editorRef: RefObject<PromptEditorHandle | null>,
  threadId: string | undefined,
  running: boolean,
  loading: boolean,
) {
  useEffect(() => {
    editorRef.current?.focus();
  }, [editorRef, threadId]);
  useEffect(() => {
    if (!running) editorRef.current?.focus();
  }, [editorRef, running]);
  useEffect(() => {
    if (!loading) editorRef.current?.focus();
  }, [editorRef, loading]);
}

/**
 * Per-thread draft persistence for the prompt editor: save on thread switch
 * and unmount (unless the prompt was just submitted), restore on switch.
 */
export function usePromptDraft({
  editorRef,
  effectiveThreadId,
  threadIdRef,
  stopRecordingRef,
  initialPromptProp,
  running,
  loading,
}: {
  editorRef: RefObject<PromptEditorHandle | null>;
  effectiveThreadId: string | undefined;
  threadIdRef: MutableRefObject<string | undefined>;
  stopRecordingRef: MutableRefObject<() => void>;
  initialPromptProp?: string;
  running: boolean;
  loading: boolean;
}) {
  const { setEditorDraft, clearPromptDraft } = useDraftStore();
  const prevThreadIdRef = useRef<string | null | undefined>(null);
  const hasSubmittedRef = useRef(false);
  const imagesRef = useRef<ImageAttachment[]>([]);

  useEffect(() => {
    const prevId = prevThreadIdRef.current;
    prevThreadIdRef.current = effectiveThreadId;
    const saveDraft = (threadId: string, editor: PromptEditorHandle | null) => {
      const editorJSON = editor?.getJSON();
      if (editorJSON) setEditorDraft(threadId, editorJSON, imagesRef.current);
    };
    swapDraftOnThreadChange(
      editorRef.current,
      prevId,
      effectiveThreadId,
      saveDraft,
      initialPromptProp,
    );
    stopRecordingRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveThreadId]);

  useEffect(() => {
    const editorRefCurrent = editorRef.current;
    const currentImages = imagesRef.current;
    return () => {
      if (hasSubmittedRef.current) return;
      const threadId = threadIdRef.current;
      const editorJSON = threadId ? editorRefCurrent?.getJSON() : undefined;
      if (threadId && editorJSON) setEditorDraft(threadId, editorJSON, currentImages);
    };
  }, [setEditorDraft, editorRef, threadIdRef]);

  useEditorAutoFocus(editorRef, effectiveThreadId, running, loading);

  useEffect(() => {
    if (initialPromptProp) editorRef.current?.setContent(initialPromptProp);
  }, [initialPromptProp, editorRef]);

  return { hasSubmittedRef, clearPromptDraft };
}
