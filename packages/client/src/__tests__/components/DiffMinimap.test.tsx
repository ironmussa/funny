import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';

import { stubGlobal, unstubAllGlobals } from '@funny/test-kit';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { DiffMinimap } from '@/components/virtual-diff/DiffMinimap';

import { buildResizeEntry } from '../helpers/builders-components';

const resizeObservers: TestResizeObserver[] = [];

class TestResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe() {}
  disconnect() {}
  unobserve() {}

  resize(height: number) {
    this.callback([buildResizeEntry(height)], this);
  }
}

describe('DiffMinimap', () => {
  beforeEach(() => {
    resizeObservers.length = 0;
    stubGlobal('ResizeObserver', TestResizeObserver);
  });

  afterEach(() => {
    unstubAllGlobals();
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
    Object.defineProperty(scrollElement, 'scrollTo', { configurable: true, value: scrollTo });

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
