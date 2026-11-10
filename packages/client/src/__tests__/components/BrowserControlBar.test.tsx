import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { BrowserControlBar } from '@/components/browser-panel/BrowserControlBar';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

import { renderWithProviders as render } from '../helpers/render';

const setUserControl = vi.fn(async () => {});
const answerDialog = vi.fn(async () => {});
const setAudioMuted = vi.fn(async () => {});
const endBrowserSession = vi.fn(async () => {});

describe('BrowserControlBar', () => {
  beforeEach(() => {
    useBrowserPanelStore.getState().reset();
    setUserControl.mockClear();
    answerDialog.mockClear();
    setAudioMuted.mockClear();
    endBrowserSession.mockClear();
    useBrowserPanelStore.setState({
      setUserControl,
      answerDialog,
      setAudioMuted,
      endBrowserSession,
    });
  });

  test('audio starts off; the toggle turns it on, then off', () => {
    useBrowserPanelStore.setState({ sessionId: 'thread:t1', sessionThreadId: 't1' });
    const { rerender } = render(<BrowserControlBar />);
    const toggle = screen.getByTestId('browser-panel-audio-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(setAudioMuted).toHaveBeenCalledWith(false);

    act(() => useBrowserPanelStore.setState({ audioMuted: false }));
    rerender(<BrowserControlBar />);
    fireEvent.click(screen.getByTestId('browser-panel-audio-toggle'));
    expect(setAudioMuted).toHaveBeenLastCalledWith(true);
  });

  test('Stop closes the session for good, also a panel-owned one', () => {
    useBrowserPanelStore.setState({ sessionId: 'bp-1', sessionThreadId: null });
    render(<BrowserControlBar />);
    fireEvent.click(screen.getByTestId('browser-panel-stop'));
    expect(endBrowserSession).toHaveBeenCalled();
  });

  test('renders nothing without a session', () => {
    const { container } = render(<BrowserControlBar />);
    expect(container).toBeEmptyDOMElement();
  });

  test('the agent controls a thread session until the user takes over', () => {
    useBrowserPanelStore.setState({ sessionId: 'thread:t1', sessionThreadId: 't1' });
    render(<BrowserControlBar />);
    expect(screen.getByTestId('browser-panel-controller')).toHaveTextContent('Agent controls');
    fireEvent.click(screen.getByTestId('browser-panel-take-over'));
    expect(setUserControl).toHaveBeenCalledWith(true);
  });

  test('while the user controls, the button hands control back', () => {
    useBrowserPanelStore.setState({
      sessionId: 'thread:t1',
      sessionThreadId: 't1',
      controller: 'user',
    });
    render(<BrowserControlBar />);
    expect(screen.getByTestId('browser-panel-controller')).toHaveTextContent('You control');
    fireEvent.click(screen.getByTestId('browser-panel-hand-back'));
    expect(setUserControl).toHaveBeenCalledWith(false);
  });

  test('a prompt dialog is answered with the typed text', () => {
    useBrowserPanelStore.setState({
      sessionId: 'thread:t1',
      sessionThreadId: 't1',
      dialog: { type: 'prompt', message: 'Your name?', defaultValue: 'x' },
    });
    render(<BrowserControlBar />);
    expect(screen.getByTestId('browser-panel-dialog')).toHaveTextContent('Your name?');
    fireEvent.change(screen.getByTestId('browser-panel-dialog-input'), {
      target: { value: 'Ada' },
    });
    fireEvent.click(screen.getByTestId('browser-panel-dialog-accept'));
    expect(answerDialog).toHaveBeenCalledWith(true, 'Ada');
  });

  test('a confirm dialog can be dismissed; an alert only has OK', () => {
    useBrowserPanelStore.setState({
      sessionId: 'thread:t1',
      sessionThreadId: 't1',
      dialog: { type: 'confirm', message: 'Leave?' },
    });
    const { unmount } = render(<BrowserControlBar />);
    fireEvent.click(screen.getByTestId('browser-panel-dialog-dismiss'));
    expect(answerDialog).toHaveBeenCalledWith(false);
    unmount();

    useBrowserPanelStore.setState({ dialog: { type: 'alert', message: 'Saved' } });
    render(<BrowserControlBar />);
    expect(screen.queryByTestId('browser-panel-dialog-dismiss')).toBeNull();
    fireEvent.click(screen.getByTestId('browser-panel-dialog-accept'));
    expect(answerDialog).toHaveBeenLastCalledWith(true, undefined);
  });
});
