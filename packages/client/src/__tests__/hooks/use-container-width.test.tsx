import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';

import { act, render } from '@testing-library/react';
import { useRef } from 'react';

import { useContainerWidth } from '@/components/thread/MemoizedMessageList.hooks';

function WidthProbe({ initialWidth }: { initialWidth: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(ref);
  return (
    <div
      ref={(node) => {
        ref.current = node;
        if (node) {
          Object.defineProperty(node, 'clientWidth', {
            configurable: true,
            value: initialWidth,
          });
        }
      }}
      data-testid="probe"
    >
      {width}
    </div>
  );
}

describe('useContainerWidth', () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  let triggerResize: ((width: number) => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    triggerResize = null;
    globalThis.ResizeObserver = class MockResizeObserver {
      private readonly cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(target: Element) {
        triggerResize = (width: number) => {
          this.cb(
            [
              {
                target,
                contentRect: { width } as DOMRectReadOnly,
              } as ResizeObserverEntry,
            ],
            this,
          );
        };
      }
      unobserve() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.ResizeObserver = originalResizeObserver;
  });

  test('debounces rapid resize bursts into a single update after settling', () => {
    const { getByTestId } = render(<WidthProbe initialWidth={800} />);
    expect(getByTestId('probe').textContent).toBe('800');

    act(() => {
      for (const width of [760, 720, 680, 640, 600]) {
        triggerResize?.(width);
        vi.advanceTimersByTime(16);
      }
    });

    // Still on the pre-animation width while resizing continuously.
    expect(getByTestId('probe').textContent).toBe('800');

    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(getByTestId('probe').textContent).toBe('600');
  });

  test('applies the first non-zero width immediately when mounted at width 0', () => {
    const { getByTestId } = render(<WidthProbe initialWidth={0} />);
    expect(getByTestId('probe').textContent).toBe('0');

    act(() => {
      triggerResize?.(640);
    });
    expect(getByTestId('probe').textContent).toBe('640');
  });
});
