/** Panel input events (mouse, wheel, keys, viewport) → CDP on the session's tab. */

import type { ChromeSession } from '@funny/core/chrome';
import type { WSBrowserSessionInputData } from '@funny/shared';

type MouseButton = 'left' | 'middle' | 'right';
type PanelInputHandler = (cs: ChromeSession, input: WSBrowserSessionInputData) => Promise<void>;

/** The button a move reports while `buttons` are held (a drag or a text selection). */
function heldButton(buttons: number | undefined): MouseButton | undefined {
  if (!buttons) return undefined;
  if (buttons & 1) return 'left';
  if (buttons & 2) return 'right';
  if (buttons & 4) return 'middle';
  return undefined;
}

function mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'): PanelInputHandler {
  return (cs, input) => {
    const held = heldButton(input.buttons);
    const event: Parameters<typeof cs.dispatchMouseEvent>[0] = {
      type,
      x: input.x ?? 0,
      y: input.y ?? 0,
      modifiers: input.modifiers ?? 0,
      buttons: input.buttons !== undefined ? input.buttons : undefined,
    };
    if (type === 'mouseMoved') {
      if (held) event.button = held;
    } else {
      event.button = input.button ?? 'left';
      event.clickCount = input.clickCount ?? 1;
    }
    return cs.dispatchMouseEvent(event);
  };
}

/** Keys the panel may send without their text, and the text each one types. */
interface KeyTextTable {
  readonly [key: string]: string;
}

/** Text a key produces when the panel did not send one (Enter submits forms). */
const KEY_TEXT: KeyTextTable = { Enter: '\r' };

/**
 * Panel keystroke → CDP. Chrome acts on non-text keys (arrows, Shift,
 * Backspace, Tab…) only with a `windowsVirtualKeyCode`, and a key that types
 * nothing is a `rawKeyDown` (as Puppeteer and Playwright send it).
 */
function panelKeyEvent(
  type: 'keyDown' | 'keyUp',
  input: WSBrowserSessionInputData,
): Parameters<ChromeSession['dispatchKeyEvent']>[0] {
  const key = input.key ?? '';
  const text = type === 'keyDown' ? (input.text ?? KEY_TEXT[key]) : undefined;
  const cdpType = type === 'keyUp' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown';
  // Undefined fields are left out of the CDP message.
  return {
    type: cdpType,
    key,
    code: input.code ?? '',
    text,
    unmodifiedText: text,
    modifiers: input.modifiers ?? 0,
    windowsVirtualKeyCode: input.keyCode,
    nativeVirtualKeyCode: input.keyCode,
    location: input.location,
  };
}

function key(type: 'keyDown' | 'keyUp'): PanelInputHandler {
  return (cs, input) => cs.dispatchKeyEvent(panelKeyEvent(type, input));
}

/** Panel input event → CDP dispatch on the session's tab. */
type PointerOrKeyKind = Exclude<
  WSBrowserSessionInputData['kind'],
  'takeControl' | 'releaseControl' | 'dialog' | 'audio' | 'viewport'
>;

/** Viewport bounds a panel resize may ask for (the same as `browser_resize`). */
const PANEL_VIEWPORT_LIMITS = { minWidth: 200, maxWidth: 3840, minHeight: 200, maxHeight: 2160 };

/** The size a panel `viewport` input asks for, or null when it is not a valid size. */
export function panelViewportSize(
  input: Pick<WSBrowserSessionInputData, 'width' | 'height'>,
): { width: number; height: number } | null {
  const { width: w, height: h } = input;
  if (w === undefined || h === undefined) return null;
  if (!Number.isInteger(w) || !Number.isInteger(h)) return null;
  const l = PANEL_VIEWPORT_LIMITS;
  if (w < l.minWidth || w > l.maxWidth || h < l.minHeight || h > l.maxHeight) return null;
  return { width: w, height: h };
}

export const PANEL_INPUT: Record<PointerOrKeyKind, PanelInputHandler> = {
  mouseMove: mouse('mouseMoved'),
  mouseDown: mouse('mousePressed'),
  mouseUp: mouse('mouseReleased'),
  wheel: (cs, input) =>
    cs.dispatchScroll(input.x ?? 0, input.y ?? 0, input.deltaX ?? 0, input.deltaY ?? 0),
  keyDown: key('keyDown'),
  keyUp: key('keyUp'),
};
