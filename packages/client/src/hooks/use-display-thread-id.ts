import { startTransition, useEffect, useState } from 'react';

import { useActiveThreadId } from '@/hooks/use-active-thread-id';
import { useThreadStore } from '@/stores/thread-store';

/**
 * Thread id used to render the main chat pane. Anchored to the URL (the active
 * thread), but keeps the previous thread visible until the new thread's payload
 * exists in `threadDataById`, then swaps via `startTransition` so the heavy
 * message list does not block the click's urgent paint (INP). Sidebar / header
 * read the URL id directly (no defer needed).
 */
export function useDisplayThreadId(): string | null {
  const activeThreadId = useActiveThreadId();
  const isPayloadReady = useThreadStore((s) =>
    activeThreadId ? !!s.threadDataById[activeThreadId] : false,
  );

  const [displayThreadId, setDisplayThreadId] = useState<string | null>(activeThreadId);

  useEffect(() => {
    if (!activeThreadId) {
      setDisplayThreadId(null);
      return;
    }
    if (!isPayloadReady) return;
    startTransition(() => {
      setDisplayThreadId(activeThreadId);
    });
  }, [activeThreadId, isPayloadReady]);

  return displayThreadId;
}
