import { useEffect, useRef, type RefObject } from 'react';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { useEditorDictation } from '@/hooks/use-editor-dictation';

/**
 * Dictation (AssemblyAI streaming) + push-to-talk wiring for the prompt
 * editor. Partial transcripts preview in the editor; final turns commit.
 */
export function usePromptDictation(editorRef: RefObject<PromptEditorHandle | null>) {
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const {
    hasAssemblyaiKey,
    partialTextRef,
    isRecording,
    isTranscribing,
    toggleRecording,
    stopRecording,
  } = useEditorDictation(editorRef, editorContainerRef);

  // When recording stops without a final turn, reset the dictation range so
  // the next push-to-talk starts at the current caret instead of replacing
  // the previously-inserted partial.
  const wasRecordingRef = useRef(false);
  useEffect(() => {
    if (wasRecordingRef.current && !isRecording) {
      editorRef.current?.endDictation();
      partialTextRef.current = '';
    }
    wasRecordingRef.current = isRecording;
  }, [isRecording, editorRef, partialTextRef]);

  const stopRecordingRef = useRef(stopRecording);
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  return {
    editorContainerRef,
    hasAssemblyaiKey,
    isRecording,
    isTranscribing,
    toggleRecording,
    stopRecording,
    stopRecordingRef,
  };
}
