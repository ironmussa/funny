/**
 * Browser errors render centered in the viewport (not under the URL bar),
 * and the disconnected screen is the only place a session error shows then.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/browser-session-client', () => ({
  browserSessionClient: { heartbeat: vi.fn(), input: vi.fn() },
}));
vi.mock('@/components/browser-panel/BrowserSessionCanvas', () => ({
  BrowserSessionCanvas: () => <canvas />,
}));

import { BrowserViewport } from '@/components/browser-panel/BrowserViewport';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

describe('browser viewport messages', () => {
  beforeEach(() => useBrowserPanelStore.getState().reset());
  afterEach(cleanup);

  test('a URL error shows centered in place of the empty hint', () => {
    render(<BrowserViewport />);
    expect(screen.queryByTestId('browser-panel-error')).toBeNull();
    expect(screen.getByText('Paste a URL above to start.')).toBeTruthy();
    act(() => useBrowserPanelStore.getState().setLoadError('Enter a URL.'));
    expect(screen.getByTestId('browser-panel-error').textContent).toBe('Enter a URL.');
    expect(screen.queryByText('Paste a URL above to start.')).toBeNull();
  });

  test('a session error on a live session shows centered', () => {
    useBrowserPanelStore.setState({
      sessionId: 's1',
      sessionStatus: 'too-many-sessions',
      sessionError: 'Too many browser sessions.',
    });
    render(<BrowserViewport />);
    expect(screen.getByTestId('browser-panel-error').textContent).toBe(
      'Too many browser sessions.',
    );
  });

  test('when disconnected the error shows only once, on the disconnected screen', () => {
    useBrowserPanelStore.setState({
      sessionId: 's1',
      sessionStatus: 'disconnected',
      sessionError: 'Browser connection unavailable.',
    });
    render(<BrowserViewport />);
    expect(screen.getByTestId('browser-panel-session-error')).toBeTruthy();
    expect(screen.queryByTestId('browser-panel-error')).toBeNull();
  });
});
