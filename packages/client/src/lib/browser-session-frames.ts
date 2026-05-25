/**
 * Receives JPEG frames from the runner and routes them to per-session canvas
 * renderers. Mirrors the pattern in `test-runner/BrowserPreview.tsx` but keyed
 * by `sessionId` so multiple panels can coexist (e.g. picture-in-picture in
 * the future).
 *
 * Frames arrive frequently (~30 fps). To minimize re-renders we keep the
 * latest frame in a module-level Map<sessionId, base64String> and emit a
 * single `'browser-session:frame'` CustomEvent so React components opt into
 * draws via `useSyncExternalStore` / `addEventListener` rather than receiving
 * an event prop on each tick.
 */

// Re-export so existing imports from this module keep working.
export {
  BROWSER_SESSION_VIEWPORT_WIDTH,
  BROWSER_SESSION_VIEWPORT_HEIGHT,
  BROWSER_SESSION_ASPECT_RATIO,
} from './browser-session-viewport';

const latestFrameBySession = new Map<string, string>();

/** Called by the WS event dispatcher when a `browser-session:frame` arrives. */
export function ingestBrowserSessionFrame(sessionId: string, base64Jpeg: string): void {
  latestFrameBySession.set(sessionId, base64Jpeg);
  window.dispatchEvent(new CustomEvent('browser-session:frame', { detail: { sessionId } }));
}

export function getLatestFrame(sessionId: string): string | null {
  return latestFrameBySession.get(sessionId) ?? null;
}

export function clearLatestFrame(sessionId: string): void {
  latestFrameBySession.delete(sessionId);
}

/**
 * Subscribe to frames for one session. Returns an unsubscribe function. Calls
 * `onFrame(base64)` whenever a new frame arrives for the given sessionId.
 */
export function subscribeToFrames(
  sessionId: string,
  onFrame: (base64: string) => void,
): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<{ sessionId: string }>).detail;
    if (detail.sessionId !== sessionId) return;
    const frame = latestFrameBySession.get(sessionId);
    if (frame) onFrame(frame);
  };
  window.addEventListener('browser-session:frame', listener);
  // Fire once with the current frame (if any) so late subscribers see the
  // last-known state immediately.
  const current = latestFrameBySession.get(sessionId);
  if (current) onFrame(current);
  return () => window.removeEventListener('browser-session:frame', listener);
}
