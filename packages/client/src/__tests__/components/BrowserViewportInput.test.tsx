/**
 * Panel input forwarding: keys carry `keyCode` (Chrome needs it for arrows,
 * Shift, Backspace…) and mouse events carry modifiers and held buttons.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const input = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-session-client', () => ({
  browserSessionClient: { input, heartbeat: vi.fn() },
}));
vi.mock('@/components/browser-panel/BrowserSessionCanvas', () => ({
  BrowserSessionCanvas: ({ canvasRef }: { canvasRef: React.RefObject<HTMLCanvasElement> }) => (
    <canvas ref={canvasRef} />
  ),
}));

import { BrowserViewport } from '@/components/browser-panel/BrowserViewport';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

describe('BrowserViewport input', () => {
  beforeEach(() => {
    input.mockClear();
    useBrowserPanelStore.getState().reset();
    useBrowserPanelStore.setState({ sessionId: 's1', tool: 'browse', sessionStatus: 'ready' });
  });

  test('Shift+ArrowLeft is sent with its key code and the Shift modifier', () => {
    render(<BrowserViewport />);
    fireEvent.keyDown(screen.getByTestId('browser-panel-overlay'), {
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      keyCode: 37,
      shiftKey: true,
    });
    expect(input).toHaveBeenCalledWith('s1', {
      kind: 'keyDown',
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      text: undefined,
      modifiers: 8,
      keyCode: 37,
      location: 0,
    });
  });

  test('mouse events carry modifiers, and moves carry the held buttons', () => {
    render(<BrowserViewport />);
    const overlay = screen.getByTestId('browser-panel-overlay');
    fireEvent.mouseDown(overlay, { button: 0, shiftKey: true });
    expect(input).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ kind: 'mouseDown', modifiers: 8 }),
    );
    fireEvent.mouseMove(overlay, { buttons: 1 });
    expect(input).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ kind: 'mouseMove', buttons: 1 }),
    );
  });

  test("keys typed into the remote page do not trigger funny's window shortcuts", () => {
    const shortcut = vi.fn();
    window.addEventListener('keydown', shortcut);
    try {
      render(<BrowserViewport />);
      const overlay = screen.getByTestId('browser-panel-overlay');
      expect(overlay).toHaveAttribute('data-keyboard-passthrough');
      fireEvent.keyDown(overlay, { key: '?', code: 'Slash', keyCode: 191, shiftKey: true });
      fireEvent.keyDown(overlay, { key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true });
      expect(shortcut).not.toHaveBeenCalled();
      expect(input).toHaveBeenLastCalledWith(
        's1',
        expect.objectContaining({ kind: 'keyDown', key: 'a', keyCode: 65, modifiers: 2 }),
      );
    } finally {
      window.removeEventListener('keydown', shortcut);
    }
  });
});
