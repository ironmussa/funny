import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ input: vi.fn(), heartbeat: vi.fn() }));
vi.mock('@/lib/browser-session-client', () => ({ browserSessionClient: mocks }));
vi.mock('@/components/browser-panel/BrowserSessionCanvas', () => ({
  BrowserSessionCanvas: () => <canvas />,
}));
vi.mock('@/components/browser-panel/tools/PinTool', () => ({ PinTool: () => null }));
vi.mock('@/components/browser-panel/tools/RegionTool', () => ({ RegionTool: () => null }));
vi.mock('@/components/browser-panel/tools/DrawTool', () => ({
  DrawTool: () => <canvas data-testid="draft-canvas" />,
}));
vi.mock('@/components/browser-panel/TestIdOverlay', () => ({ TestIdOverlay: () => null }));
vi.mock('@/components/browser-panel/InspectOverlay', () => ({ InspectOverlay: () => null }));

import { BrowserViewport } from '@/components/browser-panel/BrowserViewport';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

describe('browser viewport control and annotations', () => {
  beforeEach(() => {
    useBrowserPanelStore.getState().reset();
    useBrowserPanelStore.setState({
      sessionId: 'thread:t1',
      sessionThreadId: 't1',
      sessionStatus: 'ready',
    });
    mocks.input.mockClear();
  });
  afterEach(cleanup);

  test('blocks manual input under agent control, but hiding annotations allows browsing', () => {
    render(<BrowserViewport />);
    const viewport = screen.getByTestId('browser-panel-overlay');
    fireEvent.mouseDown(viewport);
    fireEvent.keyDown(viewport, { key: 'a' });
    expect(mocks.input).not.toHaveBeenCalled();

    act(() => {
      useBrowserPanelStore.getState().setSessionController('thread:t1', 'user');
      useBrowserPanelStore.setState({ overlaysVisible: false });
    });
    expect(viewport.style.visibility).not.toBe('hidden');
    expect(viewport.style.pointerEvents).toBe('auto');
    fireEvent.mouseDown(viewport);
    fireEvent.keyDown(viewport, { key: 'a' });
    expect(mocks.input).toHaveBeenCalledWith(
      'thread:t1',
      expect.objectContaining({ kind: 'mouseDown' }),
    );
    expect(mocks.input).toHaveBeenCalledWith(
      'thread:t1',
      expect.objectContaining({ kind: 'keyDown', key: 'a' }),
    );
  });

  test('keeps the drawing canvas mounted when handing back and taking control again', () => {
    useBrowserPanelStore.setState({ controller: 'user' });
    render(<BrowserViewport />);
    const canvas = screen.getByTestId('draft-canvas');
    expect(canvas.parentElement?.style.visibility).toBe('visible');
    act(() => useBrowserPanelStore.getState().setSessionController('thread:t1', 'agent'));
    expect(screen.getByTestId('draft-canvas')).toBe(canvas);
    expect(canvas.parentElement?.style.visibility).toBe('hidden');
    act(() => useBrowserPanelStore.getState().setSessionController('thread:t1', 'user'));
    expect(screen.getByTestId('draft-canvas')).toBe(canvas);
    expect(canvas.parentElement?.style.visibility).toBe('visible');
  });
});
