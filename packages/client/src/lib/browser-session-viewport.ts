/**
 * Single source of truth for the runner-side Chromium viewport.
 *
 * All code that scales between CSS pixels (overlay / canvas display size) and
 * CDP viewport pixels (the size the runner reports for clicks, inspect, etc.)
 * MUST use these constants. The runner-side `BrowserSessionManager` reads
 * matching constants from its own module — keep both in sync if you change
 * either side.
 */

/** Full HD — most universally "standard" desktop preset. */
export const BROWSER_SESSION_VIEWPORT_WIDTH = 1920;
export const BROWSER_SESSION_VIEWPORT_HEIGHT = 1080;

/** Aspect ratio used by the canvas CSS so the rendered page is never stretched. */
export const BROWSER_SESSION_ASPECT_RATIO = `${BROWSER_SESSION_VIEWPORT_WIDTH} / ${BROWSER_SESSION_VIEWPORT_HEIGHT}`;
