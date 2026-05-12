import { useState, useRef, useEffect, useEffectEvent, useCallback } from 'react';

import { cn } from '@/lib/utils';

import {
  SelectionPopover,
  MarginAnnotations,
  highlightTextInDom,
  type PlanComment,
  type AnnotationPosition,
} from './plan-annotations';

/**
 * Wraps content and provides text selection → popover (emoji/comment),
 * DOM highlighting of annotated text, and margin annotation icons.
 *
 * Used by both the inline ExitPlanModeCard and the PlanReviewDialog.
 */
export function AnnotatableContent({
  children,
  planComments,
  onAddComment,
  onAddEmoji,
  onRemoveComment,
  className,
  active = true,
  /** Extra deps that should trigger re-highlighting (e.g. dialog `open` state) */
  highlightDeps = [],
  /** Delay before applying highlights (useful for dialog mount) */
  highlightDelay = 0,
}: {
  children: React.ReactNode;
  planComments: PlanComment[];
  onAddComment: (selectedText: string, comment: string) => void;
  onAddEmoji: (selectedText: string, emoji: string) => void;
  onRemoveComment: (index: number) => void;
  className?: string;
  active?: boolean;
  highlightDeps?: unknown[];
  highlightDelay?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Text selection → popover ──
  const [selection, setSelection] = useState<{
    text: string;
    position: { x: number; y: number };
  } | null>(null);

  const handleMouseUp = useCallback(() => {
    if (!active) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const text = sel.toString().trim();
    if (!text) return;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const containerRect = containerRef.current?.getBoundingClientRect();
    const x = rect.left + rect.width / 2 - (containerRect?.left ?? 0);
    const y = rect.top - (containerRect?.top ?? 0);
    setSelection({ text, position: { x, y } });
  }, [active]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const onOutsideMouseDown = useEffectEvent((e: MouseEvent) => {
    const popover = document.querySelector('[data-testid="plan-selection-popover"]');
    if (popover && popover.contains(e.target as Node)) return;
    clearSelection();
  });

  // Dismiss popover on outside click
  useEffect(() => {
    if (!selection) return;
    const handleClick = (e: MouseEvent) => onOutsideMouseDown(e);
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClick), 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [selection]);

  // ── Highlight annotations + track positions ──
  const [annotationPositions, setAnnotationPositions] = useState<AnnotationPosition[]>([]);

  useEffect(() => {
    if (!active) return;

    const apply = () => {
      const container = containerRef.current;
      if (!container) {
        setAnnotationPositions([]);
        return;
      }

      // Remove existing highlights
      const existingMarks = container.querySelectorAll('mark[data-annotation-index]');
      for (const mark of existingMarks) {
        const parent = mark.parentNode;
        if (!parent) continue;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      }
      container.normalize();

      if (planComments.length === 0) {
        setAnnotationPositions([]);
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const positions: AnnotationPosition[] = [];

      for (let i = 0; i < planComments.length; i++) {
        const c = planComments[i];
        const mark = highlightTextInDom(container, c.selectedText, i);
        if (mark) {
          const markRect = mark.getBoundingClientRect();
          positions.push({
            index: i,
            top: markRect.top - containerRect.top + container.scrollTop,
            emoji: c.emoji,
            comment: c.comment,
          });
        }
      }

      setAnnotationPositions(positions);
    };

    if (highlightDelay > 0) {
      const timer = setTimeout(apply, highlightDelay);
      return () => clearTimeout(timer);
    }
    apply();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, planComments, ...highlightDeps]);

  return (
    <div
      ref={containerRef}
      className={cn('relative', className)}
      onMouseUp={handleMouseUp}
      data-testid="annotatable-content"
    >
      {children}

      <MarginAnnotations annotations={annotationPositions} onRemove={onRemoveComment} />

      {selection && (
        <SelectionPopover
          position={selection.position}
          selectedText={selection.text}
          onComment={onAddComment}
          onEmoji={onAddEmoji}
          onClose={clearSelection}
        />
      )}
    </div>
  );
}
