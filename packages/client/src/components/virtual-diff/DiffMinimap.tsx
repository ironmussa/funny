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
  totalSize,
}: {
  lines: DiffLine[];
  scrollElement: HTMLDivElement | null;
  /** Total virtual scroll height in px (from virtualizer.getTotalSize()) */
  totalSize: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportTop, setViewportTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
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
    canvas.style.width = `${MINIMAP_WIDTH}px`;
    canvas.style.height = `${height}px`;

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
      if (totalHeight === 0 || containerHeight === 0) return;

      const scrollTop = scrollElement.scrollTop;
      const clientHeight = scrollElement.clientHeight;

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

  // Handle click → scroll to position
  const handleClick = useCallback(
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
      className="relative flex-shrink-0 cursor-pointer border-l border-border/50 bg-muted/20"
      style={{ width: MINIMAP_WIDTH }}
      onClick={handleClick}
      data-testid="diff-minimap"
    >
      <canvas ref={canvasRef} className="block" />
      {/* Viewport indicator */}
      <div
        className="absolute left-0 right-0 rounded-sm border border-foreground/20 bg-foreground/10"
        style={{
          top: viewportTop,
          height: viewportHeight,
        }}
        onMouseDown={handleMouseDown}
        data-testid="diff-minimap-viewport"
      />
    </div>
  );
});
