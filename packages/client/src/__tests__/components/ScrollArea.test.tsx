import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { ScrollArea } from '@/components/ui/scroll-area';

describe('ScrollArea', () => {
  test('does not apply fade-mask viewport classes by default', () => {
    const { container } = render(
      <ScrollArea viewportProps={{ className: 'test-scroll-area-viewport' }}>
        <div>Content</div>
      </ScrollArea>,
    );

    const viewport = container.querySelector<HTMLDivElement>('.test-scroll-area-viewport')!;
    expect(viewport.className).not.toContain('fade-');
    expect(screen.queryByTestId('scroll-area-fade-top')).not.toBeInTheDocument();
    expect(screen.queryByTestId('scroll-area-fade-bottom')).not.toBeInTheDocument();
  });

  test('keeps edge fade overlays disabled for opt-in scroll areas', () => {
    const { container } = render(
      <ScrollArea edgeFade viewportProps={{ className: 'test-scroll-area-viewport' }}>
        <div>Content</div>
      </ScrollArea>,
    );

    const viewport = container.querySelector<HTMLDivElement>('.test-scroll-area-viewport')!;
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 220 });
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });

    fireEvent.scroll(viewport);
    expect(screen.queryByTestId('scroll-area-fade-top')).not.toBeInTheDocument();
    expect(screen.queryByTestId('scroll-area-fade-bottom')).not.toBeInTheDocument();

    viewport.scrollTop = 40;
    fireEvent.scroll(viewport);
    expect(screen.queryByTestId('scroll-area-fade-top')).not.toBeInTheDocument();
    expect(screen.queryByTestId('scroll-area-fade-bottom')).not.toBeInTheDocument();

    viewport.scrollTop = 120;
    fireEvent.scroll(viewport);
    expect(screen.queryByTestId('scroll-area-fade-top')).not.toBeInTheDocument();
    expect(screen.queryByTestId('scroll-area-fade-bottom')).not.toBeInTheDocument();
  });

  test('forwards viewport refs and clears them on unmount', () => {
    const objectRef = createRef<HTMLDivElement>();
    const callbackRef = vi.fn<(node: HTMLDivElement | null) => void>();

    const { unmount, rerender } = render(
      <ScrollArea viewportRef={objectRef}>
        <div>Content</div>
      </ScrollArea>,
    );

    expect(objectRef.current).toBeInstanceOf(HTMLDivElement);

    rerender(
      <ScrollArea viewportRef={callbackRef}>
        <div>Content</div>
      </ScrollArea>,
    );

    expect(objectRef.current).toBeNull();
    expect(callbackRef).toHaveBeenLastCalledWith(expect.any(HTMLDivElement));

    unmount();
    expect(callbackRef).toHaveBeenLastCalledWith(null);
  });
});
