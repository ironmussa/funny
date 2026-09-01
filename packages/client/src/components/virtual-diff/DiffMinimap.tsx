import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DiffLine } from '@/lib/diff/types';

const MINIMAP_WIDTH = 48;

/**
 * Vertical minimap bar showing where changes are in the file.
 * Each line is rendered as a 1px-high colored strip.
 * A viewport indicator shows the currently visible region.
 * Clicking on the minimap scrolls to that position.
 */
export const DiffMinimap = memo(function DiffMinimap({
  lines,
  scrollElement,
  scrollAreaId,
  totalSize,
}: {
  lines: DiffLine[];
  scrollElement: HTMLDivElement | null;
  scrollAreaId: string;
  /** Total virtual scroll height in px (from virtualizer.getTotalSize()) */
  totalSize: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportTop, setViewportTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  // Build a flat array of line types for the minimap
  // This maps each rendered row index → 'add' | 'del' | 'ctx'
  const lineTypes = useMemo(() => {
    const types: Array<'add' | 'del' | 'ctx'> = [];
    for (const line of lines) {
      types.push(line.type);
    }
    return types;
  }, [lines]);

  // Observe container height changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    ro.observe(container);
    setContainerHeight(container.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Draw the minimap canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || containerHeight === 0) return;

    const height = containerHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = MINIMAP_WIDTH * dpr;
    canvas.height = height * dpr;
    Object.assign(canvas.style, { width: `${MINIMAP_WIDTH}px`, height: `${height}px` });

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, MINIMAP_WIDTH, height);

    const totalLines = lineTypes.length;
    if (totalLines === 0) return;

    // Each line gets at least 1px, but we cap at the available height
    const lineHeight = Math.max(1, height / totalLines);
    // Use the inner area (leave padding on sides)
    const barX = 4;
    const barWidth = MINIMAP_WIDTH - 8;

    for (let i = 0; i < totalLines; i++) {
      const type = lineTypes[i];
      if (type === 'ctx') continue; // Don't draw context lines — keep it clean

      const y = (i / totalLines) * height;
      const h = Math.max(lineHeight, 2); // minimum 2px so changes are visible

      if (type === 'add') {
        ctx.fillStyle = 'hsl(142, 40%, 45%)'; // --diff-added
      } else {
        ctx.fillStyle = 'hsl(0, 45%, 55%)'; // --diff-removed
      }
      ctx.fillRect(barX, y, barWidth, h);
    }
  }, [lineTypes, containerHeight]);

  // Track viewport position via scroll events
  useEffect(() => {
    if (!scrollElement) return;

    const updateViewport = () => {
      const totalHeight = totalSize;
      if (totalHeight === 0) return;

      const scrollTop = scrollElement.scrollTop;
      const clientHeight = scrollElement.clientHeight;
      setScrollTop(scrollTop);
      if (containerHeight === 0) return;

      const ratio = containerHeight / totalHeight;
      setViewportTop(scrollTop * ratio);
      setViewportHeight(Math.max(clientHeight * ratio, 20)); // min 20px handle
    };

    updateViewport();
    scrollElement.addEventListener('scroll', updateViewport, { passive: true });
    const ro = new ResizeObserver(updateViewport);
    ro.observe(scrollElement);

    return () => {
      scrollElement.removeEventListener('scroll', updateViewport);
      ro.disconnect();
    };
  }, [scrollElement, totalSize, containerHeight]);

  // Click on minimap → scroll the viewport to that vertical position
  const scrollToClick = useCallback(
    (e: React.MouseEvent) => {
      if (!scrollElement || containerHeight === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      const ratio = clickY / containerHeight;

      const clientHeight = scrollElement.clientHeight;
      const targetScroll = ratio * totalSize - clientHeight / 2;

      scrollElement.scrollTo({
        top: Math.max(0, Math.min(targetScroll, totalSize - clientHeight)),
      });
    },
    [scrollElement, containerHeight, totalSize],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!scrollElement) return;

      const maxScroll = Math.max(0, totalSize - scrollElement.clientHeight);
      let targetScroll: number | null = null;
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowLeft':
          targetScroll = scrollElement.scrollTop - 40;
          break;
        case 'ArrowDown':
        case 'ArrowRight':
          targetScroll = scrollElement.scrollTop + 40;
          break;
        case 'PageUp':
          targetScroll = scrollElement.scrollTop - scrollElement.clientHeight;
          break;
        case 'PageDown':
          targetScroll = scrollElement.scrollTop + scrollElement.clientHeight;
          break;
        case 'Home':
          targetScroll = 0;
          break;
        case 'End':
          targetScroll = maxScroll;
          break;
      }

      if (targetScroll === null) return;
      e.preventDefault();
      scrollElement.scrollTo({ top: Math.max(0, Math.min(targetScroll, maxScroll)) });
    },
    [scrollElement, totalSize],
  );

  // Handle drag on viewport indicator
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!scrollElement || containerHeight === 0) return;

      const startY = e.clientY;
      const startScroll = scrollElement.scrollTop;
      const scale = totalSize / containerHeight;

      const onMove = (ev: MouseEvent) => {
        const deltaY = ev.clientY - startY;
        scrollElement.scrollTop = startScroll + deltaY * scale;
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [scrollElement, containerHeight, totalSize],
  );

  return (
    <div
      ref={containerRef}
      role="scrollbar"
      tabIndex={0}
      aria-label="Diff overview"
      aria-controls={scrollAreaId}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, totalSize - (scrollElement?.clientHeight ?? 0))}
      aria-valuenow={Math.round(scrollTop)}
      className="border-border/50 bg-muted/20 relative shrink-0 cursor-pointer border-l"
      style={{ width: MINIMAP_WIDTH }}
      onClick={scrollToClick}
      onKeyDown={handleKeyDown}
      onMouseDown={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-diff-minimap-viewport]')) handleMouseDown(e);
      }}
      data-testid="diff-minimap"
    >
      <canvas ref={canvasRef} className="block" />
      {/* Viewport indicator */}
      <div
        className="border-foreground/20 bg-foreground/10 absolute right-0 left-0 rounded-sm border"
        style={{
          top: viewportTop,
          height: viewportHeight,
        }}
        data-diff-minimap-viewport
        data-testid="diff-minimap-viewport"
      />
    </div>
  );
});
