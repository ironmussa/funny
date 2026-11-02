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
  | 'keyUp'
  /** Shared control: the user takes the session over from the agent. */
  | 'takeControl'
  /** Shared control: the user hands the session back to the agent. */
  | 'releaseControl'
  /** Answer the pending JavaScript dialog (`accept`, optional `promptText`). */
  | 'dialog';

export interface WSBrowserSessionInputData {
  sessionId: string;
  kind: BrowserSessionInputKind;
  x?: number;
  y?: number;
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  /** Mouse buttons held during a move (`MouseEvent.buttons` bitmask) — drags and selections. */
  buttons?: number;
  /** For key events. */
  key?: string;
  code?: string;
  text?: string;
  /** CDP modifiers bitmask (1=Alt, 2=Ctrl, 4=Meta, 8=Shift); mouse events carry it too. */
  modifiers?: number;
  /**
   * `KeyboardEvent.keyCode` — Chrome needs it as `windowsVirtualKeyCode` to
   * act on non-text keys (arrows, Shift, Backspace, Tab…).
   */
  keyCode?: number;
  /** `KeyboardEvent.location` (left/right Shift, numpad). */
  location?: number;
  /** For `dialog`: accept (true) or dismiss (false). */
  accept?: boolean;
  /** For `dialog` on a `prompt()`: the text to answer with. */
  promptText?: string;
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

/**
 * Client close reasons. `'detach'` only disconnects the panel from a
 * thread-bound session (the session keeps running for the agent);
 * `'clear-profile'` closes every session of the user and deletes the
 * persistent browser profile.
 */
export type BrowserSessionCloseRequestReason =
  | 'user'
  | 'unmount'
  | 'navigation'
  | 'detach'
  | 'clear-profile';

export interface WSBrowserSessionCloseData {
  sessionId: string;
  /** Optional client-supplied reason; defaults to `'user'` on the runner side. */
  reason?: BrowserSessionCloseRequestReason;
}

/**
 * Thread-bound sessions use a deterministic id so the panel can attach to the
 * session an agent opened (and re-attach after a reload) without a lookup.
 */
const THREAD_SESSION_PREFIX = 'thread:';

export function threadBrowserSessionId(threadId: string): string {
  return `${THREAD_SESSION_PREFIX}${threadId}`;
}

/** Thread id of a thread-bound session id, or `null` for panel-owned ids. */
export function threadIdFromBrowserSessionId(sessionId: string): string | null {
  return sessionId.startsWith(THREAD_SESSION_PREFIX)
    ? sessionId.slice(THREAD_SESSION_PREFIX.length) || null
    : null;
}

// ─── Runner → client messages ──────────────────────────────────────────────

export interface WSBrowserSessionReadyData {
  sessionId: string;
  /** Echoed back so the client can confirm the URL the runner is on. */
  url: string;
  /** Set for thread-bound sessions. */
  threadId?: string;
  /** Page viewport in CSS pixels; the panel maps input coordinates to it. */
  viewport?: { width: number; height: number };
}

/** An agent opened (or navigated) its thread's session — the panel may attach. */
export interface WSBrowserSessionAgentOpenedData {
  sessionId: string;
  threadId: string;
  url: string;
}

/** Who drives the session right now; the agent's page-changing tools wait while it is `user`. */
export type BrowserSessionController = 'agent' | 'user';

export interface WSBrowserSessionControllerData {
  sessionId: string;
  threadId?: string;
  controller: BrowserSessionController;
}

/** A JavaScript dialog is waiting for an answer (`dialog: null` once answered). */
export interface WSBrowserSessionDialogData {
  sessionId: string;
  threadId?: string;
  dialog: { type: string; message: string; defaultValue?: string } | null;
}

/** The session's page viewport changed (e.g. the agent resized it). */
export interface WSBrowserSessionViewportData {
  sessionId: string;
  threadId?: string;
  width: number;
  height: number;
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
  | 'too_many_sessions'
  /** Thread-bound session left unused (no agent calls, no panel) too long. */
  | 'idle'
  /** The session's thread was deleted or archived. */
  | 'thread_deleted'
  /** Attach attempt (`open` with an empty URL) for a session that does not exist. */
  | 'not_found';

export interface WSBrowserSessionClosedData {
  sessionId: string;
  reason: BrowserSessionClosedReason;
  threadId?: string;
  /** Free-text detail for `'error'` reasons. */
  message?: string;
}
