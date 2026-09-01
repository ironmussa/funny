import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DiffMinimap } from '@/components/virtual-diff/DiffMinimap';

const resizeObservers: TestResizeObserver[] = [];

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe() {}
  disconnect() {}
  unobserve() {}

  resize(height: number) {
    this.callback(
      [{ contentRect: { height } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

describe('DiffMinimap', () => {
  beforeEach(() => {
    resizeObservers.length = 0;
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('exposes scrollbar semantics and supports keyboard scrolling', () => {
    const scrollElement = document.createElement('div');
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 200 },
    });
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scrollElement.scrollTop = top ?? scrollElement.scrollTop;
    });
    scrollElement.scrollTo = scrollTo as unknown as typeof scrollElement.scrollTo;

    render(
      <DiffMinimap
        lines={[]}
        scrollElement={scrollElement}
        scrollAreaId="diff-scroll"
        totalSize={1000}
      />,
    );

    const minimap = screen.getByRole('scrollbar', { name: 'Diff overview' });
    expect(minimap).toHaveAttribute('aria-controls', 'diff-scroll');
    expect(minimap).toHaveAttribute('aria-valuemax', '900');
    expect(minimap).toHaveAttribute('aria-valuenow', '200');

    fireEvent.keyDown(minimap, { key: 'End' });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 900 });

    fireEvent.keyDown(minimap, { key: 'ArrowUp' });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 860 });
  });

  test('keeps pointer dragging on the viewport indicator', () => {
    const scrollElement = document.createElement('div');
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 200 },
    });

    render(
      <DiffMinimap
        lines={[]}
        scrollElement={scrollElement}
        scrollAreaId="diff-scroll"
        totalSize={1000}
      />,
    );

    act(() => resizeObservers[0].resize(100));
    fireEvent.mouseDown(screen.getByTestId('diff-minimap-viewport'), { clientY: 10 });
    fireEvent.mouseMove(document, { clientY: 20 });
    fireEvent.mouseUp(document);

    expect(scrollElement.scrollTop).toBe(300);
  });
});
