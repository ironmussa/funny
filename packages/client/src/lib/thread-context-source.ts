import { setThreadContextSource } from '@/lib/api/_core';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

/**
 * The thread whose view is open — the selected column in live columns, else
 * the active thread. Requests about its workspace run where it runs (see
 * `requestInThread`), so a sandbox thread's files, search and skills come
 * from its sandbox, never the local checkout.
 */
export function openThreadId(): string | null {
  const { liveColumnsOpen, gridSelectedThreadId } = useUIStore.getState();
  if (liveColumnsOpen) return gridSelectedThreadId ?? null;
  return useThreadStore.getState().activeThread?.id ?? null;
}

setThreadContextSource(openThreadId);
