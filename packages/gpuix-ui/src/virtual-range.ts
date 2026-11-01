export interface VisibleRangeWindowOptions {
  currentStart: number;
  itemCount: number;
  windowSize: number;
  buffer: number;
  visibleStart: number;
  visibleEnd: number;
}

export function maximumWindowStart(itemCount: number, windowSize: number): number {
  return Math.max(0, itemCount - windowSize);
}

export function clampWindowStart(start: number, itemCount: number, windowSize: number): number {
  return Math.min(maximumWindowStart(itemCount, windowSize), Math.max(0, start));
}

export function windowStartForVisibleRange({
  currentStart,
  itemCount,
  windowSize,
  buffer,
  visibleStart,
  visibleEnd,
}: VisibleRangeWindowOptions): number {
  const clampedCurrent = clampWindowStart(currentStart, itemCount, windowSize);
  const safeBuffer = Math.min(Math.max(0, buffer), Math.floor((windowSize - 1) / 2));
  const retainedEnd = clampedCurrent + windowSize;
  const safelyInsideWindow =
    visibleStart >= clampedCurrent + safeBuffer && visibleEnd <= retainedEnd - safeBuffer;
  if (safelyInsideWindow) return clampedCurrent;
  return clampWindowStart(visibleStart - safeBuffer, itemCount, windowSize);
}

export function shiftedWindowStartForItems<T extends { key: string }>(
  currentStart: number,
  previousItems: readonly T[],
  nextItems: readonly T[],
): number {
  if (previousItems.length === 0 || nextItems.length === 0) return currentStart;
  const nextIndexes = new Map(nextItems.map((item, index) => [item.key, index]));
  const anchorIndex = Math.min(previousItems.length - 1, Math.max(0, currentStart));
  for (let offset = 0; offset < previousItems.length; offset++) {
    const candidates = offset === 0 ? [anchorIndex] : [anchorIndex + offset, anchorIndex - offset];
    for (const previousIndex of candidates) {
      const previousItem = previousItems[previousIndex];
      if (!previousItem) continue;
      const nextIndex = nextIndexes.get(previousItem.key);
      if (nextIndex !== undefined) return Math.max(0, currentStart + nextIndex - previousIndex);
    }
  }
  return currentStart;
}

export interface ScrollbarPointerOptions {
  pointerY: number;
  trackTop: number;
  trackHeight: number;
  itemCount: number;
  estimatedItemHeight: number;
}

/**
 * Maps a pointer on a list's scrollbar track to the item (and pixel offset into it) to anchor at
 * the viewport top. GPUIX sizes the thumb from row heights, with unmeasured rows counted as the
 * average, so a proportional item position tracks the painted thumb.
 */
export function scrollTargetForPointer({
  pointerY,
  trackTop,
  trackHeight,
  itemCount,
  estimatedItemHeight,
}: ScrollbarPointerOptions): { index: number; offsetInItem: number } | null {
  if (itemCount <= 0 || trackHeight <= 0) return null;
  const fraction = Math.min(1, Math.max(0, (pointerY - trackTop) / trackHeight));
  const position = fraction * itemCount;
  const index = Math.min(itemCount - 1, Math.floor(position));
  return { index, offsetInItem: Math.round((position - index) * estimatedItemHeight) };
}
