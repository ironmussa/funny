import type { VirtualDiffProps } from '@/lib/diff/types';
import { cn } from '@/lib/utils';

import { HunkCheckbox } from './HunkCheckbox';

interface StickyHunkHeaderProps extends Pick<VirtualDiffProps, 'selectedLines' | 'onHunkToggle'> {
  stickyHunk: { text: string; hunkStartIdx?: number };
  rowHeight: number;
  selectable: boolean;
  hunkLineMap: Map<number, number[]>;
  gutterWidth: string;
}

/** Overlay that keeps the hunk header of the scrolled-past hunk pinned to the top. */
export function StickyHunkHeader({
  stickyHunk,
  rowHeight,
  selectable,
  hunkLineMap,
  selectedLines,
  onHunkToggle,
  gutterWidth,
}: StickyHunkHeaderProps) {
  return (
    <div
      className={cn(
        'sticky top-0 z-10 flex select-none items-center bg-accent/95 font-mono text-(length:--diff-font-size) text-muted-foreground backdrop-blur-xs border-b border-border/50 px-1',
      )}
      style={{ height: rowHeight, marginBottom: -rowHeight }}
      data-testid="diff-sticky-hunk"
    >
      {selectable && stickyHunk.hunkStartIdx != null ? (
        <HunkCheckbox
          indices={hunkLineMap.get(stickyHunk.hunkStartIdx!) ?? []}
          selectedLines={selectedLines}
          onHunkToggle={onHunkToggle}
          testId="diff-sticky-hunk-checkbox"
        />
      ) : selectable ? (
        <span className="w-5 shrink-0" />
      ) : null}
      <span className={cn(gutterWidth, 'shrink-0')} />
      <span className="truncate">{stickyHunk.text}</span>
    </div>
  );
}
