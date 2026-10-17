import { useCallback, useEffect, useRef, useState } from 'react';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';

interface UseMessageHistoryParams {
  editorRef: React.RefObject<PromptEditorHandle | null>;
  threadId?: string;
  messageHistory: readonly string[];
  onContentChange: () => void;
}

/**
 * ↑/↓ navigation through the thread's sent messages. Only the current
 * thread's messages belong in its history. Keeps a draft snapshot so ↓ after
 * the newest historical message returns the composer to exactly what the user
 * was writing before pressing ↑.
 */
export function useMessageHistory({
  editorRef,
  threadId,
  messageHistory,
  onContentChange,
}: UseMessageHistoryParams) {
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyDraftRef = useRef<ReturnType<PromptEditorHandle['getJSON']>>(undefined);

  useEffect(() => {
    setHistoryIndex(null);
    historyDraftRef.current = undefined;
  }, [threadId]);

  const showPrevious = useCallback(() => {
    const nextIndex = historyIndex === null ? messageHistory.length - 1 : historyIndex - 1;
    if (nextIndex < 0) return;
    if (historyIndex === null) historyDraftRef.current = editorRef.current?.getJSON();
    editorRef.current?.setContent(messageHistory[nextIndex]);
    setHistoryIndex(nextIndex);
    onContentChange();
  }, [editorRef, historyIndex, messageHistory, onContentChange]);

  const showNext = useCallback(
    (index: number) => {
      if (index < messageHistory.length - 1) {
        editorRef.current?.setContent(messageHistory[index + 1]);
        setHistoryIndex(index + 1);
      } else if (historyDraftRef.current) {
        editorRef.current?.setContent(historyDraftRef.current);
        historyDraftRef.current = undefined;
        setHistoryIndex(null);
      } else {
        editorRef.current?.clear();
        setHistoryIndex(null);
      }
      onContentChange();
    },
    [editorRef, messageHistory, onContentChange],
  );

  return useCallback(
    (direction: 'previous' | 'next') => {
      if (messageHistory.length === 0) return false;
      if (direction === 'previous') {
        showPrevious();
        return true;
      }
      if (historyIndex === null) return false;
      showNext(historyIndex);
      return true;
    },
    [historyIndex, messageHistory, showNext, showPrevious],
  );
}
