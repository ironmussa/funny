/**
 * Browser annotator panel — runner-managed Chromium sessions.
 *
 * The runner spawns one Chromium subprocess per active panel session,
 * connects via CDP (`@funny/core/chrome` `ChromeSession`), and streams JPEG
 * frames back to the panel. Inputs go runner → CDP (`dispatchMouseEvent` etc.)
 * and DOM inspection requests go through a request/response pair keyed by
 * `requestId`.
 *
 * See: openspec/changes/browser-panel-cdp-runtime/
 */

// ─── Client → runner messages ──────────────────────────────────────────────

export interface WSBrowserSessionOpenData {
  sessionId: string;
  url: string;
}

export interface WSBrowserSessionNavigateData {
  sessionId: string;
  url: string;
}

export type BrowserSessionInputKind =
  | 'mouseMove'
  | 'mouseDown'
  | 'mouseUp'
  | 'wheel'
  | 'keyDown'
  | 'keyUp';

export interface WSBrowserSessionInputData {
  sessionId: string;
  kind: BrowserSessionInputKind;
  x?: number;
  y?: number;
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  /** For key events. */
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
}

export interface WSBrowserSessionInspectAtData {
  sessionId: string;
  requestId: string;
  x: number;
  y: number;
}

export interface WSBrowserSessionInspectRectData {
  sessionId: string;
  requestId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WSBrowserSessionScreenshotData {
  sessionId: string;
  requestId: string;
}

export interface WSBrowserSessionExecuteData {
  sessionId: string;
  requestId: string;
  expression: string;
}

/**
 * Page-level navigation actions that need CDP-domain APIs (not page JS): back,
 * forward and reload all use `Page.navigateToHistoryEntry` / `Page.reload`.
 * The page can shadow `window.history.back` or block popstate, so going
 * through `Runtime.evaluate('history.back()')` is unreliable.
 */
export type BrowserSessionNavAction = 'back' | 'forward' | 'reload';

export interface WSBrowserSessionNavData {
  sessionId: string;
  requestId: string;
  action: BrowserSessionNavAction;
}

export interface WSBrowserSessionHeartbeatData {
  sessionId: string;
}

export interface WSBrowserSessionCloseData {
  sessionId: string;
  /** Optional client-supplied reason; defaults to `'user'` on the runner side. */
  reason?: 'user' | 'unmount' | 'navigation';
}

// ─── Runner → client messages ──────────────────────────────────────────────

export interface WSBrowserSessionReadyData {
  sessionId: string;
  /** Echoed back so the client can confirm the URL the runner is on. */
  url: string;
}

export interface WSBrowserSessionFrameData {
  sessionId: string;
  /** base64-encoded JPEG payload from CDP `Page.screencastFrame`. */
  data: string;
  timestamp: number;
}

export interface WSBrowserSessionResultData {
  sessionId: string;
  requestId: string;
  ok: boolean;
  /** Present when `ok === true`. */
  value?: unknown;
  /** Present when `ok === false`. */
  error?: string;
}

export interface WSBrowserSessionConsoleData {
  sessionId: string;
  level: string;
  text: string;
  url?: string;
  line?: number;
  column?: number;
  timestamp: number;
}

export interface WSBrowserSessionErrorData {
  sessionId: string;
  message: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string;
  timestamp: number;
}

export type BrowserSessionClosedReason =
  | 'user'
  | 'heartbeat'
  | 'error'
  | 'runner_shutdown'
  | 'too_many_sessions';

export interface WSBrowserSessionClosedData {
  sessionId: string;
  reason: BrowserSessionClosedReason;
  /** Free-text detail for `'error'` reasons. */
  message?: string;
}
