import type { Terminal } from '@xterm/xterm';
import { describe, test, expect, vi } from 'vitest';

// xterm-utils eagerly imports the real xterm bundle at module load on non-Tauri
// (`if (!isTauri) getXtermModules()`). Flag Tauri before importing so the unit
// under test loads without pulling in the WebGL/canvas bundle under jsdom.
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
const { flushPausedRender, repaintVisibleTerminal } =
  await import('@/components/terminal/xterm-utils');

/**
 * Minimal stand-in for an xterm Terminal that exposes just the private render
 * service surface flushPausedRender reaches into. `_handleIntersectionChange`
 * records its calls so we can assert the un-pause path fires.
 */
function makeFakeTerminal({
  paused,
  withInternals = true,
}: {
  paused: boolean;
  withInternals?: boolean;
}) {
  const calls: Array<{ isIntersecting: boolean; intersectionRatio: number }> = [];
  const renderService = {
    _isPaused: paused,
    _handleIntersectionChange: (e: { isIntersecting: boolean; intersectionRatio: number }) => {
      calls.push(e);
      renderService._isPaused = !e.isIntersecting;
    },
  };
  const terminal = withInternals ? { _core: { _renderService: renderService } } : {};
  return {
    terminal: {
      ...terminal,
      rows: 24,
      refresh: vi.fn(),
    } as unknown as Terminal & { refresh: ReturnType<typeof vi.fn> },
    calls,
    renderService,
  };
}

describe('flushPausedRender', () => {
  test('un-pauses a stuck (paused) renderer by driving the intersection handler', () => {
    const { terminal, calls, renderService } = makeFakeTerminal({ paused: true });
    flushPausedRender(terminal);
    expect(calls).toEqual([{ isIntersecting: true, intersectionRatio: 1 }]);
    expect(renderService._isPaused).toBe(false);
  });

  test('is a no-op when the renderer is not paused (avoids per-write thrash)', () => {
    const { terminal, calls } = makeFakeTerminal({ paused: false });
    flushPausedRender(terminal);
    expect(calls).toEqual([]);
  });

  test('degrades to a silent no-op when xterm internals are absent', () => {
    const { terminal } = makeFakeTerminal({ paused: true, withInternals: false });
    expect(() => flushPausedRender(terminal)).not.toThrow();
  });
});

describe('repaintVisibleTerminal', () => {
  test('un-pauses before refreshing a visible terminal', () => {
    const { terminal, calls } = makeFakeTerminal({ paused: true });
    const container = document.createElement('div');
    vi.spyOn(container, 'offsetParent', 'get').mockReturnValue(document.body);

    repaintVisibleTerminal(terminal, container);

    expect(calls).toEqual([{ isIntersecting: true, intersectionRatio: 1 }]);
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
  });

  test('refreshes without forcing intersection when the terminal is hidden', () => {
    const { terminal, calls } = makeFakeTerminal({ paused: true });
    const container = document.createElement('div');
    vi.spyOn(container, 'offsetParent', 'get').mockReturnValue(null);

    repaintVisibleTerminal(terminal, container);

    expect(calls).toEqual([]);
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
  });
});
