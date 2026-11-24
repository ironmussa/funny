import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  mock,
  setDefaultTimeout,
} from 'bun:test';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mocks = (() => ({ input: vi.fn(), heartbeat: vi.fn() }))();
mock.module('@/lib/browser-session-client', () => ({ browserSessionClient: mocks }));
mock.module('@/components/browser-panel/BrowserSessionCanvas', () => ({
  BrowserSessionCanvas: () => <canvas />,
}));
mock.module('@/components/browser-panel/tools/PinTool', () => ({ PinTool: () => null }));
mock.module('@/components/browser-panel/tools/RegionTool', () => ({ RegionTool: () => null }));
mock.module('@/components/browser-panel/tools/DrawTool', () => ({
  DrawTool: () => <canvas data-testid="draft-canvas" />,
}));
mock.module('@/components/browser-panel/TestIdOverlay', () => ({ TestIdOverlay: () => null }));
mock.module('@/components/browser-panel/InspectOverlay', () => ({ InspectOverlay: () => null }));

import { BrowserViewport } from '@/components/browser-panel/BrowserViewport';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
import { useBrowserPointerStore } from '@/stores/browser-pointer-store';

// The proof and pre-push run these files together under `bun test --parallel`; on a
// loaded machine a first render (cold module load) ran well past the 5 s default.
setDefaultTimeout(60_000);

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
    expect(viewport).not.toHaveClass('invisible');
    expect(viewport).toHaveClass('pointer-events-auto');
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
    expect(canvas.parentElement).toHaveClass('visible');
    act(() => useBrowserPanelStore.getState().setSessionController('thread:t1', 'agent'));
    expect(screen.getByTestId('draft-canvas')).toBe(canvas);
    expect(canvas.parentElement).toHaveClass('invisible');
    act(() => useBrowserPanelStore.getState().setSessionController('thread:t1', 'user'));
    expect(screen.getByTestId('draft-canvas')).toBe(canvas);
    expect(canvas.parentElement).toHaveClass('visible');
  });

  test("hides the agent's pointer once the session disconnects", () => {
    act(() =>
      useBrowserPointerStore.getState().setPointer('thread:t1', { x: 5, y: 5, kind: 'click' }),
    );
    render(<BrowserViewport />);
    expect(screen.getByTestId('browser-agent-pointer')).toBeInTheDocument();

    act(() => useBrowserPanelStore.setState({ sessionStatus: 'disconnected' }));
    expect(screen.queryByTestId('browser-agent-pointer')).not.toBeInTheDocument();
    act(() => useBrowserPointerStore.setState({ bySession: {} }));
  });
});
