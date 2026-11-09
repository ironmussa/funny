import type { QueuedMessage } from '@funny/shared';
import { useCallback, type MutableRefObject } from 'react';

import { cancelQueuedMessage, editQueuedMessage } from '@/data/queue/actions';
import { useLoadedQueue } from '@/data/queue/hooks';
import { toastError } from '@/lib/toast-error';

import { buildPreviewQueue, pickRenderedQueue } from './prompt-queue-patches';

const EMPTY_QUEUED_MESSAGES: QueuedMessage[] = [];

/** Edit / cancel handlers for queued messages, bound to the latest thread id. */
function useQueueHandlers(threadIdRef: MutableRefObject<string | undefined>) {
  const handleQueueEditSave = useCallback(
    async (messageId: string, content: string) => {
      const tid = threadIdRef.current;
      if (!tid) return;
      const result = await editQueuedMessage(tid, messageId, content);
      if (result.isErr()) toastError(result.error);
    },
    [threadIdRef],
  );

  const handleQueueDelete = useCallback(
    async (messageId: string) => {
      const tid = threadIdRef.current;
      if (!tid) return;
      const result = await cancelQueuedMessage(tid, messageId);
      if (result.isErr()) toastError(result.error);
    },
    [threadIdRef],
  );

  return { handleQueueEditSave, handleQueueDelete };
}

interface UsePromptQueueArgs {
  effectiveThreadId: string | undefined;
  threadIdRef: MutableRefObject<string | undefined>;
}

/** Queue lifecycle for the composer: summary, lazy full fetch, and edit/delete handlers. */
export function usePromptQueue({ effectiveThreadId, threadIdRef }: UsePromptQueueArgs) {
  const { row, loading } = useLoadedQueue(effectiveThreadId);
  const queuedCount = row?.count ?? 0;
  const queuedNextMessage = row?.next;

  // The loaded list is shown only while it still matches the summary's next
  // message; otherwise the preview row stands in until the refetch lands.
  const loaded = row?.messages ?? EMPTY_QUEUED_MESSAGES;
  const current =
    queuedCount > 0 && (!queuedNextMessage || loaded[0]?.content === queuedNextMessage)
      ? loaded
      : EMPTY_QUEUED_MESSAGES;

  const { handleQueueEditSave, handleQueueDelete } = useQueueHandlers(threadIdRef);

  return {
    queuedCount,
    queuedMessages: pickRenderedQueue(
      current,
      buildPreviewQueue(effectiveThreadId, queuedCount, queuedNextMessage),
    ),
    queueLoading: loading,
    handleQueueEditSave,
    handleQueueDelete,
  };
}
