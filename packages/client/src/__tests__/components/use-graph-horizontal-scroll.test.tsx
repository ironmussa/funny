import { describe, expect, test } from 'bun:test';

/**
 * The commit graph's lane gutter scrolls sideways on a horizontal wheel. React
 * registers `onWheel` as passive, so the hook listens natively with
 * `passive: false`: otherwise `preventDefault()` is refused, with a console
 * error on every wheel tick.
 */
import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';

import { useGraphHorizontalScroll } from '@/components/commit-graph/use-graph-horizontal-scroll';
// The widest the gutter's viewport gets (`commit-graph-layout`): wider lanes scroll.
const GRAPH_GUTTER_MAX_VIEWPORT_PX = 320;

function Graph({ gutterWidth }: { gutterWidth: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { clampedGraphScrollLeft } = useGraphHorizontalScroll(rootRef, gutterWidth);
  return (
    <div ref={rootRef}>
      <div data-graph-gutter="">
        <span data-testid="gutter-child" />
      </div>
      <span data-testid="title" />
      <output data-testid="scroll">{clampedGraphScrollLeft}</output>
    </div>
  );
}

function wheel(target: Element, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('useGraphHorizontalScroll', () => {
  test('a horizontal wheel over the gutter scrolls the lanes and is cancelled', () => {
    render(<Graph gutterWidth={GRAPH_GUTTER_MAX_VIEWPORT_PX + 200} />);
    const event = wheel(screen.getByTestId('gutter-child'), { deltaX: 40 });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId('scroll')).toHaveTextContent('40');
  });

  test('shift + vertical wheel scrolls the lanes; a plain vertical wheel scrolls the list', () => {
    render(<Graph gutterWidth={GRAPH_GUTTER_MAX_VIEWPORT_PX + 200} />);
    const gutter = screen.getByTestId('gutter-child');
    expect(wheel(gutter, { deltaY: 30 }).defaultPrevented).toBe(false);
    expect(wheel(gutter, { deltaY: 30, shiftKey: true }).defaultPrevented).toBe(true);
    expect(screen.getByTestId('scroll')).toHaveTextContent('30');
  });

  test('a wheel outside the gutter, or with no lanes to scroll, is left alone', () => {
    const { unmount } = render(<Graph gutterWidth={GRAPH_GUTTER_MAX_VIEWPORT_PX + 200} />);
    expect(wheel(screen.getByTestId('title'), { deltaX: 40 }).defaultPrevented).toBe(false);
    unmount();
    render(<Graph gutterWidth={100} />);
    expect(wheel(screen.getByTestId('gutter-child'), { deltaX: 40 }).defaultPrevented).toBe(false);
  });
});
