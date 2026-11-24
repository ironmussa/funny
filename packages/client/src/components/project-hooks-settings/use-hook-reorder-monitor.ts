import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { ProjectHook, HookType } from '@funny/shared';
import { useEffect, type Dispatch, type SetStateAction } from 'react';

import { api } from '@/lib/api';

/** Reorders hooks of one type when a hook row is dropped on another, and persists the order. */
export function useHookReorderMonitor(
  selectedProjectId: string | null,
  setHooks: Dispatch<SetStateAction<ProjectHook[]>>,
) {
  useEffect(() => {
    return monitorForElements({
      onDrop({ source, location }) {
        const targets = location.current.dropTargets;
        if (!targets.length) return;
        if (source.data.type !== 'hook-item') return;

        const sourceHookType = source.data.hookType as HookType;
        const sourceIndex = source.data.index as number;
        const targetIndex = targets[0].data.index as number;
        if (sourceIndex === targetIndex || sourceHookType !== targets[0].data.hookType) return;

        setHooks((prev) => {
          // Get hooks of this type
          const typeHooks = prev.filter((h) => h.hookType === sourceHookType);
          const others = prev.filter((h) => h.hookType !== sourceHookType);

          const oldIdx = typeHooks.findIndex((h) => h.index === sourceIndex);
          const newIdx = typeHooks.findIndex((h) => h.index === targetIndex);
          if (oldIdx === -1 || newIdx === -1) return prev;

          const reordered = [...typeHooks];
          const [moved] = reordered.splice(oldIdx, 1);
          reordered.splice(newIdx, 0, moved);

          // Persist reorder
          if (selectedProjectId) {
            const newOrder = reordered.map((h) => h.index);
            api.reorderHooks(selectedProjectId, sourceHookType, newOrder);
          }

          // Update indexes
          const updated = reordered.map((h, i) => ({ ...h, index: i }));
          return [...others, ...updated];
        });
      },
    });
  }, [selectedProjectId, setHooks]);
}
