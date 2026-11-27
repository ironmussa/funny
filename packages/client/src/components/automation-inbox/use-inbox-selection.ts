import type { InboxItem } from '@funny/shared';
import { useMemo, useRef, useState } from 'react';

/**
 * The runs checked in the inbox list. Shift-click on a checkbox selects the
 * range from the last one clicked. A checked run that the filters hide stays
 * out of `selected`, so a bulk action never reaches it.
 */
export function useInboxSelection(items: InboxItem[]) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);

  const selected = useMemo(
    () => items.flatMap((i) => (checked.has(i.run.id) ? [i.run.id] : [])),
    [items, checked],
  );

  const toggle = (runId: string, shift: boolean) => {
    // Read the anchor now: the state updater may run after it moves.
    const ids = items.map((i) => i.run.id);
    const from = anchorRef.current ? ids.indexOf(anchorRef.current) : -1;
    const to = ids.indexOf(runId);
    anchorRef.current = runId;
    setChecked((prev) => {
      const next = new Set(prev);
      if (shift && from >= 0 && to >= 0) {
        const on = !prev.has(runId);
        for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) {
          if (on) next.add(id);
          else next.delete(id);
        }
      } else if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const toggleAll = () =>
    setChecked(selected.length === items.length ? new Set() : new Set(items.map((i) => i.run.id)));
  const clear = () => setChecked(new Set());

  return { checked, selected, visibleCount: items.length, toggle, toggleAll, clear };
}

export type InboxSelection = ReturnType<typeof useInboxSelection>;
