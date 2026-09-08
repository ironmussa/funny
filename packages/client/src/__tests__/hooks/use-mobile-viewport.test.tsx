import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { APP_SCROLL_LOCK_CLASS } from '@/hooks/use-app-scroll-lock';
import { useMobileViewport } from '@/hooks/use-mobile-viewport';

function Shell() {
  const ref = useMobileViewport();
  return <div ref={ref} data-testid="viewport" />;
}

afterEach(() => vi.unstubAllGlobals());

test('tracks keyboard height and browser panning, then releases listeners and scroll lock', () => {
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  const removeListener = vi.spyOn(viewport, 'removeEventListener');
  const { unmount } = render(<Shell />);
  const shell = screen.getByTestId('viewport');
  expect(shell).toHaveStyle({ height: '800px', top: '0px' });
  expect(document.documentElement).toHaveClass(APP_SCROLL_LOCK_CLASS);

  act(() => {
    viewport.height = 420;
    viewport.offsetTop = 120;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(shell).toHaveStyle({ height: '420px', top: '120px' });
  act(() => {
    viewport.offsetTop = 160;
    viewport.dispatchEvent(new Event('scroll'));
  });
  expect(shell).toHaveStyle({ top: '160px' });

  act(() => {
    viewport.height = 800;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(shell).toHaveStyle({ height: '800px', top: '0px' });
  unmount();
  expect(document.documentElement).not.toHaveClass(APP_SCROLL_LOCK_CLASS);
  expect(removeListener).toHaveBeenCalledWith('resize', expect.any(Function));
  expect(removeListener).toHaveBeenCalledWith('scroll', expect.any(Function));
});

test('uses window height when VisualViewport is unavailable', () => {
  vi.stubGlobal('visualViewport', undefined);
  vi.stubGlobal('innerHeight', 700);
  render(<Shell />);
  expect(screen.getByTestId('viewport')).toHaveStyle({ height: '700px', top: '0px' });
  act(() => {
    vi.stubGlobal('innerHeight', 400);
    window.dispatchEvent(new Event('resize'));
  });
  expect(screen.getByTestId('viewport')).toHaveStyle({ height: '400px' });
});
