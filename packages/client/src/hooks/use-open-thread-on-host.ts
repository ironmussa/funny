import { useThreadById } from '@/lib/thread-selectors';
import { canOpenOnHost } from '@/lib/thread-variant';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

/**
 * `canOpenOnHost` for the thread whose view is open (the same thread
 * `lib/thread-context-source.ts` routes requests to). True outside a thread.
 */
export function useOpenThreadOnHost(): boolean {
  const liveColumnsOpen = useUIStore((s) => s.liveColumnsOpen);
  const gridSelectedThreadId = useUIStore((s) => s.gridSelectedThreadId);
  const activeThreadId = useThreadStore((s) => s.activeThread?.id ?? null);
  const thread = useThreadById(liveColumnsOpen ? gridSelectedThreadId : activeThreadId);
  return canOpenOnHost(thread);
}
