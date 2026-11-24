import { useCallback, useEffect, useRef } from 'react';

import type { VirtualDiffProps } from '@/lib/diff/types';

/** Drag-select (GitHub Desktop-style click+drag on checkboxes) for `VirtualDiff`. */
export function useDiffDragSelect({
  selectable,
  selectedLines,
  onDragSelect,
}: Pick<VirtualDiffProps, 'selectedLines' | 'onDragSelect'> & { selectable: boolean }) {
  const dragRef = useRef<{
    active: boolean;
    mode: boolean;
    startLineIdx: number;
  }>({ active: false, mode: true, startLineIdx: -1 });

  const getLineIdxFromEvent = useCallback((e: React.MouseEvent | MouseEvent): number | null => {
    const el = (e.target as HTMLElement).closest('[data-line-idx]');
    if (!el) return null;
    const v = Number(el.getAttribute('data-line-idx'));
    return Number.isFinite(v) ? v : null;
  }, []);

  const handleDragMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!selectable || !onDragSelect || e.button !== 0) return;
      // Only start drag when clicking on the gutter area (checkbox / line numbers)
      const target = e.target as HTMLElement;
      if (!target.closest('[data-gutter]')) return;
      const lineIdx = getLineIdxFromEvent(e);
      if (lineIdx == null) return;
      const willSelect = !selectedLines?.has(lineIdx);
      dragRef.current = { active: true, mode: willSelect, startLineIdx: lineIdx };
      onDragSelect(lineIdx, lineIdx, willSelect);
      e.preventDefault();
    },
    [selectable, onDragSelect, selectedLines, getLineIdxFromEvent],
  );

  const handleDragMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragRef.current.active || !onDragSelect) return;
      const lineIdx = getLineIdxFromEvent(e);
      if (lineIdx == null) return;
      onDragSelect(dragRef.current.startLineIdx, lineIdx, dragRef.current.mode);
    },
    [onDragSelect, getLineIdxFromEvent],
  );

  const handleDragMouseUp = useCallback(() => {
    dragRef.current = { active: false, mode: true, startLineIdx: -1 };
  }, []);

  useEffect(() => {
    if (!selectable) return;
    const handler = () => {
      dragRef.current = { active: false, mode: true, startLineIdx: -1 };
    };
    window.addEventListener('mouseup', handler);
    return () => window.removeEventListener('mouseup', handler);
  }, [selectable]);

  return { handleDragMouseDown, handleDragMouseMove, handleDragMouseUp };
}
