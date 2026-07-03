import { useEffect, useRef, type RefObject } from 'react';

interface UsePushToTalkOptions {
  enabled: boolean;
  containerRef: RefObject<HTMLElement | null>;
  isRecording: boolean;
  isTranscribing: boolean;
  startRecording: () => void;
  stopRecording: () => void;
}

/**
 * Ctrl+Alt push-to-talk: starts dictation while both modifiers are held and
 * focus is inside `containerRef`. Releases stop the recording after a short
 * debounce so brief lifts during continuous speech don't cut the stream.
 *
 * Shared between the main prompt input and tool-card inputs (AskQuestion /
 * ExitPlanMode "Other"/follow-up fields) so the shortcut works everywhere a
 * dictation-capable input is focused.
 */
export function usePushToTalk({
  enabled,
  containerRef,
  isRecording,
  isTranscribing,
  startRecording,
  stopRecording,
}: UsePushToTalkOptions) {
  const pttActiveRef = useRef(false);
  const isRecordingRef = useRef(isRecording);
  const isTranscribingRef = useRef(isTranscribing);
  const startRecordingRef = useRef(startRecording);
  const stopRecordingRef = useRef(stopRecording);
  const pttStopTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);
  useEffect(() => {
    isTranscribingRef.current = isTranscribing;
  }, [isTranscribing]);
  useEffect(() => {
    startRecordingRef.current = startRecording;
  }, [startRecording]);
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  useEffect(() => {
    if (!enabled) return;

    const keysDown = { ctrl: false, alt: false };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control') keysDown.ctrl = true;
      if (e.key === 'Alt') keysDown.alt = true;

      const active = document.activeElement;
      const inScope = active && containerRef.current?.contains(active);
      if (
        keysDown.ctrl &&
        keysDown.alt &&
        inScope &&
        !pttActiveRef.current &&
        !isRecordingRef.current &&
        !isTranscribingRef.current
      ) {
        e.preventDefault();
        if (pttStopTimerRef.current) {
          clearTimeout(pttStopTimerRef.current);
          pttStopTimerRef.current = undefined;
        }
        pttActiveRef.current = true;
        startRecordingRef.current();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') keysDown.ctrl = false;
      if (e.key === 'Alt') keysDown.alt = false;

      if (pttActiveRef.current && (!keysDown.ctrl || !keysDown.alt)) {
        pttActiveRef.current = false;
        pttStopTimerRef.current = setTimeout(() => {
          pttStopTimerRef.current = undefined;
          stopRecordingRef.current();
        }, 500);
      }
    };

    const handleBlur = () => {
      keysDown.ctrl = false;
      keysDown.alt = false;
      if (pttActiveRef.current) pttActiveRef.current = false;
      if (pttStopTimerRef.current) {
        clearTimeout(pttStopTimerRef.current);
        pttStopTimerRef.current = undefined;
      }
      stopRecordingRef.current();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      if (pttStopTimerRef.current) clearTimeout(pttStopTimerRef.current);
    };
  }, [enabled, containerRef]);
}
