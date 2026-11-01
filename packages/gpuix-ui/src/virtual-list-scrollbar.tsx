import { useGpuix } from '@gpuix/react';
import type { EventPayload, PublicInstance } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { isPrimaryDockDrag } from './dock-layout-model';
import { PointerCapture } from './pointer-capture';
import { SCROLLABLE_LIST_CONTAINER } from './theme';
import { scrollTargetForPointer } from './virtual-range';

/** Wider than the painted 6px thumb so it is easy to grab. */
const TRACK_WIDTH = 12;
/** Hit-testable but invisible: GPUI only blocks pointer input on elements that paint a fill. */
const HIT_AREA_FILL = '#00000001';

export interface VirtualListScrollbarProps {
  /** Native id of the `<virtual-list>` to scroll; `null` until it mounts. */
  listId: number | null;
  itemCount: number;
  estimatedItemHeight: number;
  testId?: string;
}

/**
 * Makes a `<virtual-list>` scrollbar draggable. GPUIX paints the thumb (`scrollbarColor`) but
 * gives it no pointer input, so this overlays a transparent track on the list's right edge:
 * pressing or dragging on it scrolls the list to the matching item. Render it as a sibling after
 * the list inside a container that the list fills.
 */
export function VirtualListScrollbar({
  listId,
  itemCount,
  estimatedItemHeight,
  testId = 'virtual-list-scrollbar',
}: VirtualListScrollbarProps): ReactElement | null {
  const { renderer } = useGpuix();
  const trackId = useRef<number | null>(null);
  const trackBounds = useRef<{ y: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const scrollToPointer = useCallback(
    (event: EventPayload) => {
      const bounds = trackBounds.current;
      if (listId === null || !bounds || event.y === undefined) return;
      const target = scrollTargetForPointer({
        pointerY: event.y,
        trackTop: bounds.y,
        trackHeight: bounds.height,
        itemCount,
        estimatedItemHeight,
      });
      if (target) renderer?.scrollToItem?.(listId, target.index, target.offsetInItem);
    },
    [estimatedItemHeight, itemCount, listId, renderer],
  );

  const stopDragging = useCallback(() => setDragging(false), []);

  if (itemCount === 0) return null;
  return (
    <>
      <div
        ref={(instance: PublicInstance | null) => {
          trackId.current = instance?.id ?? null;
        }}
        testId={testId}
        onMouseDown={(event) => {
          if (!isPrimaryDockDrag(event.button) || trackId.current === null) return;
          trackBounds.current = renderer?.getElementBounds?.(trackId.current) ?? null;
          setDragging(true);
          scrollToPointer(event);
        }}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: TRACK_WIDTH,
          pointerEvents: 'auto',
          backgroundColor: HIT_AREA_FILL,
          userSelect: 'none',
        }}
      />
      {dragging ? (
        <PointerCapture>
          <div
            testId={`${testId}-capture`}
            onMouseMove={(event) => {
              if (isPrimaryDockDrag(event.pressedButton)) scrollToPointer(event);
              else stopDragging();
            }}
            onMouseUp={stopDragging}
            onMouseLeave={stopDragging}
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              pointerEvents: 'auto',
              backgroundColor: HIT_AREA_FILL,
              userSelect: 'none',
            }}
          />
        </PointerCapture>
      ) : null}
    </>
  );
}

type WindowedVirtualListProps = Extract<
  JSX.IntrinsicElements['virtual-list'],
  { itemCount: number }
>;

export type ScrollableVirtualListProps = Omit<WindowedVirtualListProps, 'ref'> & {
  /** Receives the native list id, e.g. to drive `scrollToItem` from outside. */
  onListId?: (id: number | null) => void;
  scrollbarTestId?: string;
};

/** A windowed `<virtual-list>` whose painted scrollbar thumb can be dragged. */
export function ScrollableVirtualList({
  onListId,
  scrollbarTestId,
  ...props
}: ScrollableVirtualListProps): ReactElement {
  const [listId, setListId] = useState<number | null>(null);
  // A stable ref callback: a new one per render would detach and re-attach the list each commit.
  const onListIdRef = useRef(onListId);
  useLayoutEffect(() => {
    onListIdRef.current = onListId;
  }, [onListId]);
  const listRef = useCallback((instance: PublicInstance | null) => {
    const id = instance?.id ?? null;
    setListId(id);
    onListIdRef.current?.(id);
  }, []);
  return (
    <div style={SCROLLABLE_LIST_CONTAINER}>
      <virtual-list {...props} ref={listRef} />
      <VirtualListScrollbar
        listId={listId}
        itemCount={props.itemCount}
        estimatedItemHeight={props.estimatedItemHeight}
        testId={scrollbarTestId}
      />
    </div>
  );
}
