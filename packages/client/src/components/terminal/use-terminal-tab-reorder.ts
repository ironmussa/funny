import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { reorderWithEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/util/reorder-with-edge';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useEffect } from 'react';

import { TAB_DRAG_TYPE } from '@/components/terminal/DraggableTerminalTab';
import { useTerminalStore } from '@/stores/terminal-store';

/** Reorder a project's terminal tabs when one of its tabs is dropped on another. */
export function useTerminalTabReorder(
  projectId: string | null | undefined,
  reorderTabs: (projectId: string, startIndex: number, finishIndex: number) => void,
): void {
  useEffect(() => {
    if (!projectId) return;
    return monitorForElements({
      canMonitor: ({ source }) =>
        source.data.type === TAB_DRAG_TYPE && source.data.projectId === projectId,
      onDrop: ({ source, location }) => {
        const target = location.current.dropTargets[0];
        if (!target) return;
        if (target.data.type !== TAB_DRAG_TYPE) return;
        if (target.data.projectId !== projectId) return;
        if (source.data.tabId === target.data.tabId) return;

        // SAFETY: both sides passed the TAB_DRAG_TYPE check, and DraggableTerminalTab
        // sets `index` to a number and `tabId` to a string on that data.
        const startIndex = source.data.index as number;
        // SAFETY: as above.
        const indexOfTarget = target.data.index as number;
        const closestEdgeOfTarget = extractClosestEdge(target.data);

        const currentOrder = useTerminalStore
          .getState()
          .tabs.filter((t) => t.projectId === projectId)
          .map((t) => t.id);
        const reordered = reorderWithEdge({
          list: currentOrder,
          startIndex,
          indexOfTarget,
          closestEdgeOfTarget,
          axis: 'horizontal',
        });
        // SAFETY: as above.
        const finishIndex = reordered.indexOf(source.data.tabId as string);
        if (finishIndex === startIndex) return;
        reorderTabs(projectId, startIndex, finishIndex);
      },
    });
  }, [projectId, reorderTabs]);
}
