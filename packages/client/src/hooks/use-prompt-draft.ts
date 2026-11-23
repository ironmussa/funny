import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import type { PromptAttachmentsHandle } from '@/components/prompt-input/use-prompt-attachments';
import { useDraftStore } from '@/stores/draft-store';

type Draft = ReturnType<typeof useDraftStore.getState>['drafts'][string];

/** Content to load into the editor for a thread: saved draft, then initial prompt. */
function pickDraftContent(draft: Draft | undefined, initialPrompt: string | undefined) {
  return draft?.editorContent || draft?.prompt || initialPrompt || undefined;
}

/**
 * Loads a thread's saved images into the composer. On the first run (mount)
 * the composer keeps its `initialImages` unless the draft has images of its own.
 */
function restoreDraftImages(
  attachments: PromptAttachmentsHandle | null,
  draft: Draft | undefined,
  isMount: boolean,
) {
  const images = draft?.images ?? [];
  if (isMount && images.length === 0) return;
  attachments?.reset(images);
}

/** Saves the previous thread's draft (editor + images) and loads the next thread's. */
function swapDraftOnThreadChange(
  editor: PromptEditorHandle | null,
  attachments: PromptAttachmentsHandle | null,
  prevId: string | null | undefined,
  nextId: string | undefined,
  saveDraft: (threadId: string) => void,
  initialPrompt: string | undefined,
) {
  if (prevId && prevId !== nextId) saveDraft(prevId);

  if (nextId && nextId !== prevId) {
    const draft = useDraftStore.getState().drafts[nextId];
    const content = pickDraftContent(draft, initialPrompt);
    if (content) editor?.setContent(content);
    else editor?.clear();
    restoreDraftImages(attachments, draft, prevId === null);
  } else if (!nextId && prevId) {
    editor?.clear();
    attachments?.reset([]);
  }
}

/** Re-focuses the editor on thread switch and whenever the agent goes idle. */
/**
 * Saves the draft when the prompt unmounts. It reads the refs' values at
 * unmount on purpose: the thread, attachments and submitted flag that are
 * current then, not the ones from when the effect ran.
 */
function saveDraftOnUnmount(
  editor: PromptEditorHandle | null,
  refs: {
    hasSubmittedRef: MutableRefObject<boolean>;
    threadIdRef: MutableRefObject<string | undefined>;
    attachmentsRef: RefObject<PromptAttachmentsHandle | null>;
  },
  setEditorDraft: ReturnType<typeof useDraftStore.getState>['setEditorDraft'],
) {
  if (refs.hasSubmittedRef.current) return;
  const threadId = refs.threadIdRef.current;
  const editorJSON = threadId ? editor?.getJSON() : undefined;
  const images = refs.attachmentsRef.current?.getImages() ?? [];
  if (threadId && editorJSON) setEditorDraft(threadId, editorJSON, images);
}

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
 * Per-thread draft persistence for the composer (editor content and image
 * attachments): save on thread switch and unmount (unless the prompt was just
 * submitted), restore on switch. Text-file attachments are not kept in drafts;
 * they are dropped on switch so they never follow the user to another thread.
 */
export function usePromptDraft({
  editorRef,
  attachmentsRef,
  effectiveThreadId,
  threadIdRef,
  stopRecordingRef,
  initialPromptProp,
  running,
  loading,
}: {
  editorRef: RefObject<PromptEditorHandle | null>;
  attachmentsRef: RefObject<PromptAttachmentsHandle | null>;
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

  useEffect(() => {
    const prevId = prevThreadIdRef.current;
    prevThreadIdRef.current = effectiveThreadId;
    const editor = editorRef.current;
    const attachments = attachmentsRef.current;
    const saveDraft = (threadId: string) => {
      const editorJSON = editor?.getJSON();
      if (editorJSON) setEditorDraft(threadId, editorJSON, attachments?.getImages() ?? []);
    };
    swapDraftOnThreadChange(
      editor,
      attachments,
      prevId,
      effectiveThreadId,
      saveDraft,
      initialPromptProp,
    );
    stopRecordingRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveThreadId]);

  useEffect(() => {
    const editor = editorRef.current;
    return () =>
      saveDraftOnUnmount(editor, { hasSubmittedRef, threadIdRef, attachmentsRef }, setEditorDraft);
  }, [setEditorDraft, editorRef, attachmentsRef, threadIdRef]);

  useEditorAutoFocus(editorRef, effectiveThreadId, running, loading);

  useEffect(() => {
    if (initialPromptProp) editorRef.current?.setContent(initialPromptProp);
  }, [initialPromptProp, editorRef]);

  return { hasSubmittedRef, clearPromptDraft };
}
