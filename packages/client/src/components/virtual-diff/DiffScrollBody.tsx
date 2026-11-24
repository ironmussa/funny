import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, Ref } from 'react';

import type { RenderRow } from '@/lib/diff/types';
import { cn } from '@/lib/utils';

import { DiffRowContent } from './DiffRowContent';
import type { DiffRowContentProps } from './DiffRowContent';
import { StickyHunkHeader } from './StickyHunkHeader';

interface DiffScrollBodyProps {
  showMinimap: boolean;
  className: string | undefined;
  testId: string | undefined;
  scrollAreaId: string;
  scrollCallbackRef: (node: HTMLDivElement | null) => void;
  hScrollBarRef: Ref<HTMLDivElement>;
  hSpacerWidth: number;
  needsHScroll: boolean;
  drag: {
    handleDragMouseDown: (e: ReactMouseEvent) => void;
    handleDragMouseMove: (e: ReactMouseEvent) => void;
    handleDragMouseUp: () => void;
  };
  stickyHunk: { text: string; hunkStartIdx?: number } | null;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  renderRows: RenderRow[];
  rowHeightMap: Map<number, number> | null;
  totalSize: number;
  maxContentWidth: number;
  /** Search matches before each render row (prefix sums), when searching. */
  matchOffsets: number[] | undefined;
  /** Props shared by every row's content. */
  rowContent: Omit<DiffRowContentProps, 'row' | 'matchOffset'>;
}

type DragHandlers = DiffScrollBodyProps['drag'];

/** Swallow clicks on the gutter so the checkboxes only react to drag-select. */
function swallowGutterClick(e: ReactMouseEvent) {
  const target = e.target as HTMLElement;
  if (target.closest('[data-gutter]')) {
    e.stopPropagation();
    e.preventDefault();
  }
}

/** Pointer handlers of the scroll area: drag-select, only when lines are selectable. */
function scrollAreaHandlers(selectable: boolean, drag: DragHandlers) {
  if (!selectable) {
    return {
      onMouseDown: undefined,
      onMouseMove: undefined,
      onMouseUp: undefined,
      onClickCapture: undefined,
    };
  }
  return {
    onMouseDown: drag.handleDragMouseDown,
    onMouseMove: drag.handleDragMouseMove,
    onMouseUp: drag.handleDragMouseUp,
    onClickCapture: swallowGutterClick,
  };
}

/**
 * Width of the rows container. In split/three-pane mode, horizontal scroll is
 * handled via CSS translateX on each pane's text — the container must stay at
 * 100% so flex-1 columns divide the *visible* width equally. Only unified mode
 * needs to expand the container for native h-scroll.
 */
function rowsContainerWidth(maxContentWidth: number, needsHScroll: boolean): number | string {
  return maxContentWidth > 0 && !needsHScroll ? maxContentWidth : '100%';
}

/** One absolutely positioned virtual row; measured by the virtualizer when wrapping. */
function VirtualRowSlot({
  vItem,
  rowH,
  wordWrap,
  measureElement,
  children,
}: {
  vItem: VirtualItem;
  rowH: number;
  wordWrap: boolean;
  measureElement: (node: Element | null) => void;
  children: ReactNode;
}) {
  return (
    <div
      {...(wordWrap ? { ref: measureElement, 'data-index': vItem.index } : {})}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        ...(wordWrap ? { minHeight: rowH } : { height: rowH }),
        transform: `translateY(${vItem.start}px)`,
      }}
    >
      {children}
    </div>
  );
}

/** The virtualized rows container: only the rows in view are mounted. */
function DiffVirtualRows({
  virtualizer,
  renderRows,
  rowHeightMap,
  totalSize,
  width,
  matchOffsets,
  rowContent,
}: Pick<
  DiffScrollBodyProps,
  'virtualizer' | 'renderRows' | 'rowHeightMap' | 'totalSize' | 'matchOffsets' | 'rowContent'
> & { width: number | string }) {
  return (
    <div
      style={{
        height: totalSize,
        minWidth: '100%',
        width,
        position: 'relative',
      }}
    >
      {virtualizer.getVirtualItems().map((vItem) => (
        <VirtualRowSlot
          key={vItem.index}
          vItem={vItem}
          rowH={rowHeightMap?.get(vItem.index) ?? rowContent.rowHeight}
          wordWrap={rowContent.wordWrap}
          measureElement={virtualizer.measureElement}
        >
          <DiffRowContent
            {...rowContent}
            row={renderRows[vItem.index]}
            matchOffset={matchOffsets?.[vItem.index]}
          />
        </VirtualRowSlot>
      ))}
    </div>
  );
}

/** Single horizontal scrollbar for split/three-pane mode. */
function DiffHScrollbar({
  hScrollBarRef,
  hSpacerWidth,
}: {
  hScrollBarRef: Ref<HTMLDivElement>;
  hSpacerWidth: number;
}) {
  return (
    <div
      ref={hScrollBarRef}
      className="scroll-fade-none scrollbar-visible shrink-0 overflow-x-auto overflow-y-hidden"
      style={{ height: 10 }}
      data-testid="diff-h-scrollbar"
    >
      <div style={{ width: hSpacerWidth, height: 1 }} />
    </div>
  );
}

/** The vertical scroll area: sticky hunk header over the virtualized rows. */
function DiffScrollArea({
  scrollAreaId,
  scrollCallbackRef,
  needsHScroll,
  drag,
  stickyHunk,
  virtualizer,
  renderRows,
  rowHeightMap,
  totalSize,
  maxContentWidth,
  matchOffsets,
  rowContent,
}: Omit<
  DiffScrollBodyProps,
  'showMinimap' | 'className' | 'testId' | 'hScrollBarRef' | 'hSpacerWidth'
>) {
  // Pointer handlers implement text/gutter selection; actionable checkboxes remain keyboard controls.
  return (
    // react-doctor-disable-next-line react-doctor/click-events-have-key-events, react-doctor/no-static-element-interactions
    <div
      id={scrollAreaId}
      ref={scrollCallbackRef}
      className={cn(
        'scroll-fade-none scrollbar-visible h-full min-h-0 relative',
        needsHScroll ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto',
      )}
      style={{ scrollbarGutter: 'stable' }}
      data-testid="diff-scroll-area"
      {...scrollAreaHandlers(rowContent.selectable, drag)}
    >
      {/* Sticky hunk header overlay */}
      {stickyHunk && (
        <StickyHunkHeader
          stickyHunk={stickyHunk}
          rowHeight={rowContent.rowHeight}
          selectable={rowContent.selectable}
          hunkLineMap={rowContent.hunkLineMap}
          selectedLines={rowContent.selectedLines}
          onHunkToggle={rowContent.onHunkToggle}
          gutterWidth={rowContent.gutterWidth}
        />
      )}
      <DiffVirtualRows
        virtualizer={virtualizer}
        renderRows={renderRows}
        rowHeightMap={rowHeightMap}
        totalSize={totalSize}
        width={rowsContainerWidth(maxContentWidth, needsHScroll)}
        matchOffsets={matchOffsets}
        rowContent={rowContent}
      />
    </div>
  );
}

/**
 * The scrollable body of `VirtualDiff`: scroll frame, sticky hunk header,
 * virtualized rows and the single horizontal scrollbar of split/three-pane.
 */
export function DiffScrollBody({
  showMinimap,
  className,
  testId,
  scrollAreaId,
  scrollCallbackRef,
  hScrollBarRef,
  hSpacerWidth,
  needsHScroll,
  drag,
  stickyHunk,
  virtualizer,
  renderRows,
  rowHeightMap,
  totalSize,
  maxContentWidth,
  matchOffsets,
  rowContent,
}: DiffScrollBodyProps) {
  return (
    <div
      className={cn('flex flex-col', showMinimap ? 'flex-1 min-w-0' : className)}
      data-testid={testId}
    >
      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        style={
          {
            '--diff-scrollbar-gutter': '12px',
          } as CSSProperties
        }
        data-testid="diff-scroll-frame"
      >
        {/* Vertical scroll area */}
        <DiffScrollArea
          scrollAreaId={scrollAreaId}
          scrollCallbackRef={scrollCallbackRef}
          needsHScroll={needsHScroll}
          drag={drag}
          stickyHunk={stickyHunk}
          virtualizer={virtualizer}
          renderRows={renderRows}
          rowHeightMap={rowHeightMap}
          totalSize={totalSize}
          maxContentWidth={maxContentWidth}
          matchOffsets={matchOffsets}
          rowContent={rowContent}
        />
      </div>
      {/* Single horizontal scrollbar for split/three-pane mode */}
      {needsHScroll && <DiffHScrollbar hScrollBarRef={hScrollBarRef} hSpacerWidth={hSpacerWidth} />}
    </div>
  );
}
