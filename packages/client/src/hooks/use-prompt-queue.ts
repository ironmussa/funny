import type { QueuedMessage } from '@funny/shared';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { toastError } from '@/lib/toast-error';
import { useThreadStore } from '@/stores/thread-store';

import type { ThreadOverride } from './prompt-input-types';
import {
  buildPreviewQueue,
  pickRenderedQueue,
  queueDeletedPatch,
  queueEditedPatch,
  queueFetchedPatch,
} from './prompt-queue-patches';

const queueLog = createClientLogger('PromptInputQueue');

const EMPTY_QUEUED_MESSAGES: QueuedMessage[] = [];

type QueueFetchKey = {
  threadId: string;
  queuedCount: number;
  queuedNextMessage?: string;
};

type SetQueue = Dispatch<SetStateAction<QueuedMessage[]>>;

const clearQueue = (setQueuedMessages: SetQueue) =>
  setQueuedMessages((prev) => (prev.length === 0 ? prev : []));

function isSameFetch(a: QueueFetchKey | null, b: QueueFetchKey): boolean {
  return (
    !!a &&
    a.threadId === b.threadId &&
    a.queuedCount === b.queuedCount &&
    a.queuedNextMessage === b.queuedNextMessage
  );
}

interface QueueSyncContext {
  threadId: string | undefined;
  queuedCount: number;
  queuedNextMessage: string | undefined;
  lastFetchRef: MutableRefObject<QueueFetchKey | null>;
  setQueuedMessages: SetQueue;
  setQueueLoading: (v: boolean) => void;
}

/**
 * Resets local queue state for the current snapshot and decides whether the
 * full queue must be fetched. Returns the fetch key, or null to skip.
 */
function prepareQueueSync(ctx: QueueSyncContext): QueueFetchKey | null {
  const { threadId, queuedCount, queuedNextMessage, lastFetchRef } = ctx;
  if (!threadId) {
    clearQueue(ctx.setQueuedMessages);
    ctx.setQueueLoading(false);
    lastFetchRef.current = null;
    return null;
  }

  // Switched to a different thread than the last fetch — clear the previous
  // thread's queue immediately so we never render its messages under the
  // new thread while the fetch is in flight. Without this the local
  // `queuedMessages` state persists across thread switches and contaminates
  // the new thread's input bar.
  const lastFetch = lastFetchRef.current;
  if (lastFetch && lastFetch.threadId !== threadId) clearQueue(ctx.setQueuedMessages);

  // When queuedCount is 0, clear locally without hitting the API.
  if (queuedCount === 0) {
    clearQueue(ctx.setQueuedMessages);
    ctx.setQueueLoading(false);
    lastFetchRef.current = { threadId, queuedCount: 0 };
    return null;
  }

  if (queuedNextMessage) {
    ctx.setQueuedMessages((prev) =>
      prev.length > 0 && prev[0]?.content !== queuedNextMessage ? [] : prev,
    );
  }

  // Skip if we already fired a fetch for this exact threadId + queue snapshot
  // (prevents StrictMode double-fire from issuing duplicate requests)
  const key = { threadId, queuedCount, queuedNextMessage };
  if (isSameFetch(lastFetch, key)) {
    queueLog.debug('queue effect: skipped (dedup)', {
      threadId,
      queuedCount: String(queuedCount),
    });
    return null;
  }
  return key;
}

async function fetchQueue(
  key: QueueFetchKey,
  ctx: QueueSyncContext,
  isCancelled: () => boolean,
): Promise<void> {
  const { threadId, queuedCount } = key;
  const result = await api.listQueue(threadId);
  if (isCancelled()) return;
  if (result.isOk()) {
    queueLog.info('queue effect: fetched queue', {
      threadId,
      messageCount: String(result.value.length),
    });
    ctx.setQueuedMessages(result.value);
    ctx.lastFetchRef.current = {
      threadId,
      queuedCount,
      queuedNextMessage: result.value[0]?.content,
    };
    useThreadStore.setState((state) => queueFetchedPatch(state, threadId, result.value));
  } else {
    queueLog.warn('queue effect: fetch failed', { threadId, error: result.error.message });
    clearQueue(ctx.setQueuedMessages);
  }
  ctx.setQueueLoading(false);
}

/** Queue summary (count + next message) for a thread, from the persistent store maps. */
function useQueueSummary(
  threadId: string | undefined,
  threadOverride: ThreadOverride | undefined,
  queuedCountProp: number,
  queuedNextMessageProp: string | undefined,
) {
  // Source of truth: `queuedCountByThread` (persistent across thread switches
  // and payload unloads). Payload-level `queuedCount` is only updated when the
  // thread is hydrated in `threadDataById`, so a `queue:update` for a thread
  // that was unloaded would silently drop. The persistent map always reflects
  // the latest server state.
  const storeQueuedCount = useThreadStore((s) =>
    threadId
      ? (s.queuedCountByThread[threadId] ?? s.threadDataById[threadId]?.queuedCount ?? 0)
      : 0,
  );
  const cachedQueuedMessages = useThreadStore((s) =>
    threadId
      ? (s.queuedMessagesByThread[threadId] ?? EMPTY_QUEUED_MESSAGES)
      : EMPTY_QUEUED_MESSAGES,
  );
  const storeQueuedNextMessage = useThreadStore((s) =>
    threadId
      ? (s.queuedNextMessageByThread[threadId] ?? s.threadDataById[threadId]?.queuedNextMessage)
      : undefined,
  );
  const queuedCount =
    storeQueuedCount > 0 ? storeQueuedCount : (threadOverride?.queuedCount ?? queuedCountProp);
  return {
    queuedCount,
    cachedQueuedMessages,
    queuedNextMessage: storeQueuedNextMessage ?? queuedNextMessageProp,
  };
}

/** Edit / cancel handlers for queued messages, bound to the latest thread id. */
function useQueueHandlers(
  threadIdRef: MutableRefObject<string | undefined>,
  setQueuedMessages: SetQueue,
) {
  const handleQueueEditSave = useCallback(
    async (messageId: string, content: string) => {
      const tid = threadIdRef.current;
      if (!tid) return;
      const result = await api.updateQueuedMessage(tid, messageId, content);
      if (result.isErr()) {
        toastError(result.error);
        return;
      }
      setQueuedMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content } : m)));
      useThreadStore.setState((state) => queueEditedPatch(state, tid, messageId, content));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleQueueDelete = useCallback(
    async (messageId: string) => {
      const tid = threadIdRef.current;
      if (!tid) return;
      const result = await api.cancelQueuedMessage(tid, messageId);
      if (result.isErr()) {
        toastError(result.error);
        return;
      }
      setQueuedMessages((prev) => prev.filter((m) => m.id !== messageId));
      // Sync the store's queuedCount with the server's authoritative value.
      const newCount = result.value.queuedCount;
      useThreadStore.setState((state) => queueDeletedPatch(state, tid, messageId, newCount));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return { handleQueueEditSave, handleQueueDelete };
}

interface UsePromptQueueArgs {
  effectiveThreadId: string | undefined;
  threadIdRef: MutableRefObject<string | undefined>;
  threadOverride?: ThreadOverride;
  queuedCountProp: number;
  queuedNextMessageProp?: string;
}

/** Queue lifecycle for the composer: summary, lazy full fetch, and edit/delete handlers. */
export function usePromptQueue({
  effectiveThreadId,
  threadIdRef,
  threadOverride,
  queuedCountProp,
  queuedNextMessageProp,
}: UsePromptQueueArgs) {
  const { queuedCount, cachedQueuedMessages, queuedNextMessage } = useQueueSummary(
    effectiveThreadId,
    threadOverride,
    queuedCountProp,
    queuedNextMessageProp,
  );
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const lastQueueFetchRef = useRef<QueueFetchKey | null>(null);

  useEffect(() => {
    const ctx: QueueSyncContext = {
      threadId: effectiveThreadId,
      queuedCount,
      queuedNextMessage,
      lastFetchRef: lastQueueFetchRef,
      setQueuedMessages,
      setQueueLoading,
    };
    const key = prepareQueueSync(ctx);
    if (!key) return;
    lastQueueFetchRef.current = key;

    queueLog.info('queue effect: fetching queue', {
      threadId: key.threadId,
      queuedCount: String(queuedCount),
    });

    let cancelled = false;
    setQueueLoading(true);
    void fetchQueue(key, ctx, () => cancelled);

    return () => {
      cancelled = true;
    };
  }, [effectiveThreadId, queuedCount, queuedNextMessage]);

  const { handleQueueEditSave, handleQueueDelete } = useQueueHandlers(
    threadIdRef,
    setQueuedMessages,
  );

  const renderedQueuedMessages = pickRenderedQueue(
    queuedMessages,
    cachedQueuedMessages,
    buildPreviewQueue(effectiveThreadId, queuedCount, queuedNextMessage),
  );

  return {
    queuedCount,
    queuedMessages: renderedQueuedMessages,
    queueLoading,
    handleQueueEditSave,
    handleQueueDelete,
  };
}
