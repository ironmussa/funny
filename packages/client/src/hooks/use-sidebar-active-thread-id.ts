import { effectiveThreadId } from '@/lib/grid-right-pane';
import { useUIStore } from '@/stores/ui-store';

import { useActiveThreadId } from './use-active-thread-id';

/**
 * The thread id that should appear selected/highlighted in the left sidebar.
 *
 * Follows the URL-derived active thread normally, and follows the focused
 * grid cell (`gridSelectedThreadId`) while the grid view (`liveColumnsOpen`)
 * is open. Outside the grid, `gridSelectedThreadId` has no effect.
 */
export function useSidebarActiveThreadId(): string | null {
  const activeThreadId = useActiveThreadId();
  const liveColumnsOpen = useUIStore((s) => s.liveColumnsOpen);
  const gridSelectedThreadId = useUIStore((s) => s.gridSelectedThreadId);
  return effectiveThreadId(liveColumnsOpen, gridSelectedThreadId, activeThreadId);
}
