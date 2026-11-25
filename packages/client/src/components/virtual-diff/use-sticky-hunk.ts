import type { Virtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';

import type { RenderRow } from '@/lib/diff/types';

/**
 * Sticky hunk header of `VirtualDiff`: the last hunk header scrolled past the
 * top of the scroll area, found through the virtualizer's measurements.
 */
export function useStickyHunk(
  renderRows: RenderRow[],
  scrollRef: RefObject<HTMLDivElement | null>,
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  rowHeight: number,
) {
  // Build sorted list of hunk row indices so we can find which one to stick
  const hunkRowPositions = useMemo(() => {
    const positions: { index: number; text: string; hunkStartIdx?: number }[] = [];
    for (let i = 0; i < renderRows.length; i++) {
      const row = renderRows[i];
      if (row.type === 'hunk') {
        positions.push({ index: i, text: row.text, hunkStartIdx: row.hunkStartIdx });
      }
    }
    return positions;
  }, [renderRows]);

  const [stickyHunk, setStickyHunk] = useState<{
    text: string;
    hunkStartIdx?: number;
  } | null>(null);

  // Update sticky hunk on scroll — use virtualizer range to find the stuck header
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || hunkRowPositions.length === 0) return;
    const onScroll = () => {
      const scrollTop = el.scrollTop;
      // Only show sticky when scrolled past the hunk header (not when it's still visible)
      let found: (typeof hunkRowPositions)[0] | null = null;
      for (const hp of hunkRowPositions) {
        const item = virtualizer.measurementsCache[hp.index];
        const rowTop = item ? item.start : hp.index * rowHeight;
        if (rowTop + rowHeight <= scrollTop) {
          found = hp;
        } else {
          break;
        }
      }
      setStickyHunk(found);
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [hunkRowPositions, virtualizer, rowHeight, scrollRef]);

  return stickyHunk;
}
