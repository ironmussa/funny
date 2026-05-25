/**
 * Client-side helpers for talking to the runner's BrowserSessionManager.
 *
 * Fire-and-forget messages go through `getActiveWS().emit(...)`. Request-style
 * messages (`inspect-at`, `inspect-rect`, `screenshot`, `execute`) wait for a
 * matching `browser-session:result` with the supplied `requestId`.
 *
 * Frame events are routed elsewhere — see `dispatch-browser-session-events.ts`.
 */

import { getActiveWS } from '@/hooks/use-ws';
import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('browser-session');

// ── Request/response routing ──────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRequest>();

const REQUEST_TIMEOUT_MS = 5000;

let nextId = 0;
function newRequestId(): string {
  nextId = (nextId + 1) % Number.MAX_SAFE_INTEGER;
  return `bs-${Date.now().toString(36)}-${nextId.toString(36)}`;
}

/**
 * Called from `dispatch-browser-session-events.ts` when a `result` arrives.
 * Resolves the awaiting Promise (if any) and clears state.
 */
export function resolveBrowserSessionRequest(
  requestId: string,
  ok: boolean,
  value: unknown,
  error: string | undefined,
): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  if (ok) entry.resolve(value);
  else entry.reject(new Error(error ?? 'unknown error'));
}

function sendRequest(
  type: string,
  sessionId: string,
  extra: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = getActiveWS();
    if (!ws || !ws.connected) {
      reject(new Error('ws-not-connected'));
      return;
    }
    const requestId = newRequestId();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('timeout'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timer });
    ws.emit(type, { sessionId, requestId, ...extra });
  });
}

function sendFireAndForget(
  type: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
): void {
  const ws = getActiveWS();
  if (!ws || !ws.connected) return;
  ws.emit(type, { sessionId, ...extra });
}

// ── Public API ───────────────────────────────────────────────────────────

export const browserSessionClient = {
  /** Open a new session (or navigate the existing one — the runner decides). */
  open(sessionId: string, url: string): void {
    log.info('open', { sessionId, url });
    sendFireAndForget('browser-session:open', sessionId, { url });
  },

  navigate(sessionId: string, url: string): void {
    sendFireAndForget('browser-session:navigate', sessionId, { url });
  },

  /** Mouse / wheel / keyboard input — fire-and-forget. */
  input(sessionId: string, input: Record<string, unknown>): void {
    sendFireAndForget('browser-session:input', sessionId, input);
  },

  /** Request the element under (x, y) — returns the AnnotationDomInfo shape. */
  inspectAt(sessionId: string, x: number, y: number): Promise<unknown> {
    return sendRequest('browser-session:inspect-at', sessionId, { x, y });
  },

  /** Request the elements inside the rectangle — returns AnnotationRegionDom['elements']. */
  inspectRect(sessionId: string, x: number, y: number, w: number, h: number): Promise<unknown> {
    return sendRequest('browser-session:inspect-rect', sessionId, { x, y, w, h });
  },

  /** Request a viewport screenshot (PNG base64). */
  screenshot(sessionId: string): Promise<unknown> {
    return sendRequest('browser-session:screenshot', sessionId, {});
  },

  /** Evaluate arbitrary JS in the page; returns whatever the expression evaluates to. */
  execute(sessionId: string, expression: string): Promise<unknown> {
    return sendRequest('browser-session:execute', sessionId, { expression });
  },

  /**
   * Back / forward / reload via CDP `Page.navigateToHistoryEntry` / `Page.reload`.
   * Resolves to `false` (no history entry available) for back/forward when
   * stuck at the ends, `true` otherwise.
   */
  nav(sessionId: string, action: 'back' | 'forward' | 'reload'): Promise<unknown> {
    return sendRequest('browser-session:nav', sessionId, { action });
  },

  heartbeat(sessionId: string): void {
    sendFireAndForget('browser-session:heartbeat', sessionId);
  },

  close(sessionId: string, reason: 'user' | 'unmount' | 'navigation' = 'user'): void {
    log.info('close', { sessionId, reason });
    sendFireAndForget('browser-session:close', sessionId, { reason });
  },
};
