import { useCallback, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { useDictation } from '@/hooks/use-dictation';
import { usePushToTalk } from '@/hooks/use-push-to-talk';
import { useProfileStore } from '@/stores/profile-store';

/**
 * Real-time dictation (AssemblyAI streaming) into a PromptEditor, plus
 * push-to-talk inside `containerRef`. Partial transcripts preview in the
 * editor; final turns commit.
 */
export function useEditorDictation(
  editorRef: RefObject<PromptEditorHandle | null>,
  containerRef: RefObject<HTMLDivElement | null>,
) {
  const { t } = useTranslation();
  const hasAssemblyaiKey = useProfileStore((s) => s.profile?.hasAssemblyaiKey ?? false);
  const partialTextRef = useRef('');

  const handlePartialTranscript = useCallback(
    (text: string) => {
      partialTextRef.current = text;
      if (text) editorRef.current?.setDictationPreview(text);
    },
    [editorRef],
  );

  const handleFinalTranscript = useCallback(
    (text: string) => {
      if (text) editorRef.current?.commitDictation(text);
      partialTextRef.current = '';
    },
    [editorRef],
  );

  const handleDictationError = useCallback(
    (message: string) => {
      toast.error(message || t('prompt.micPermissionDenied', 'Microphone access denied'));
    },
    [t],
  );

  const {
    isRecording,
    isConnecting: isTranscribing,
    start: startRecording,
    toggle: toggleRecording,
    stop: stopRecording,
  } = useDictation({
    onPartial: handlePartialTranscript,
    onFinal: handleFinalTranscript,
    onError: handleDictationError,
  });

  usePushToTalk({
    enabled: hasAssemblyaiKey,
    containerRef,
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
  });

  return {
    hasAssemblyaiKey,
    partialTextRef,
    isRecording,
    isTranscribing,
    toggleRecording,
    stopRecording,
  };
}
