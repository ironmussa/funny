import { effectiveThreadId, rightPaneProjectId } from '@/lib/grid-right-pane';
import { useThreadById } from '@/lib/thread-selectors';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

/**
 * The thread the right pane (review / files / comments) should scope to.
 *
 * In the normal view this is the store's `selectedThreadId` (set on thread
 * click). In the grid view, threads have no URL and aren't "selected" through
 * the usual flow — the focused thread is `gridSelectedThreadId`, so the right
 * pane must follow that instead. Gated on `liveColumnsOpen` so the grid
 * selection has NO effect outside the grid. See `grid-thread-actions`.
 */
export function useRightPaneThreadId(): string | null {
  const liveColumnsOpen = useUIStore((s) => s.liveColumnsOpen);
  const gridSelectedThreadId = useUIStore((s) => s.gridSelectedThreadId);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  return effectiveThreadId(liveColumnsOpen, gridSelectedThreadId, selectedThreadId);
}

/**
 * The project the right pane should scope to. In the grid view this is the
 * grid-selected thread's project; otherwise the store's `selectedProjectId`.
 *
 * Use the lightweight thread index instead of ThreadContext here. A freshly
 * selected grid column can update before its heavy `threadDataById` payload is
 * hydrated, but the sidebar/thread index already has the project id the Files
 * pane and review state need.
 */
export function useRightPaneProjectId(): string | null {
  const liveColumnsOpen = useUIStore((s) => s.liveColumnsOpen);
  const gridSelectedThreadId = useUIStore((s) => s.gridSelectedThreadId);
  const gridSelectedThread = useThreadById(gridSelectedThreadId);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  return rightPaneProjectId(
    liveColumnsOpen,
    gridSelectedThread?.projectId || null,
    selectedProjectId,
  );
}
