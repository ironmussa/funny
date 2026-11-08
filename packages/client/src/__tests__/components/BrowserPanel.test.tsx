import { act, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/components/browser-panel/BrowserUrlBar', () => ({
  BrowserUrlBar: () => <div>URL bar</div>,
}));
vi.mock('@/components/browser-panel/BrowserViewport', () => ({
  BrowserViewport: () => <div>Viewport</div>,
}));
vi.mock('@/components/browser-panel/ToolToolbar', () => ({
  ToolToolbar: () => <div>Annotation tools</div>,
}));
vi.mock('@/components/browser-panel/AnnotationList', () => ({
  AnnotationList: () => <div>Annotation list</div>,
}));
vi.mock('@/components/browser-panel/SendDialog', () => ({
  BrowserPanelFooter: () => <button>Send annotations</button>,
}));

import { BrowserPanel } from '@/components/browser-panel/BrowserPanel';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

describe('browser annotation mode', () => {
  beforeEach(() => {
    useBrowserPanelStore.getState().reset();
    useBrowserPanelStore.setState({
      open: true,
      sessionId: 'thread:t1',
      sessionThreadId: 't1',
      sessionStatus: 'ready',
    });
  });
  afterEach(cleanup);

  test('shows tools immediately on takeover and hides them when handing back', () => {
    render(<BrowserPanel />);
    expect(screen.queryByText('Annotation tools')).toBeNull();
    expect(screen.queryByText('Annotation list')).toBeNull();
    expect(screen.queryByText('Send annotations')).toBeNull();

    act(() => useBrowserPanelStore.getState().setSessionController('thread:t1', 'user'));
    expect(screen.queryByTestId('browser-panel-annotation-mode')).toBeNull();
    expect(screen.getByText('Annotation tools')).toBeTruthy();
    expect(screen.getByText('Annotation list')).toBeTruthy();
    expect(screen.getByText('Send annotations')).toBeTruthy();

    act(() => useBrowserPanelStore.getState().setSessionController('thread:t1', 'agent'));
    expect(screen.queryByText('Annotation tools')).toBeNull();
    expect(screen.queryByText('Annotation list')).toBeNull();
    expect(screen.queryByText('Send annotations')).toBeNull();

    act(() => useBrowserPanelStore.getState().setSessionController('thread:t1', 'user'));
    expect(screen.getByText('Annotation tools')).toBeTruthy();
  });

  test('waits for the session to be ready before showing tools', () => {
    useBrowserPanelStore.setState({ controller: 'user', sessionStatus: 'spawning' });
    render(<BrowserPanel />);
    expect(screen.queryByText('Annotation tools')).toBeNull();
    act(() => useBrowserPanelStore.getState().setSessionStatus('ready'));
    expect(screen.getByText('Annotation tools')).toBeTruthy();
  });
});
