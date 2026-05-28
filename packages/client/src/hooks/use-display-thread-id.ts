import { startTransition, useEffect, useState } from 'react';

import { useThreadStore } from '@/stores/thread-store';

/**
 * Thread id used to render the main chat pane. Keeps the previous thread visible
 * until the newly-selected thread's payload exists in `threadDataById`, then
 * swaps via `startTransition` so the heavy message list does not block the
 * click's urgent paint (INP). Sidebar / header use `selectedThreadId` directly.
 */
export function useDisplayThreadId(): string | null {
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const isPayloadReady = useThreadStore((s) =>
    selectedThreadId ? !!s.threadDataById[selectedThreadId] : false,
  );

  const [displayThreadId, setDisplayThreadId] = useState<string | null>(selectedThreadId);

  useEffect(() => {
    if (!selectedThreadId) {
      setDisplayThreadId(null);
      return;
    }
    if (!isPayloadReady) return;
    startTransition(() => {
      setDisplayThreadId(selectedThreadId);
    });
  }, [selectedThreadId, isPayloadReady]);

  return displayThreadId;
}
