/**
 * Default viewport of the runner-side Chromium.
 *
 * A session starts at this size; the runner reports the live size in
 * `browser-session:ready` / `browser-session:viewport` (the agent can resize
 * it), and panel components scale between CSS pixels and CDP viewport pixels
 * with the store's `viewport`. The runner-side `BrowserSessionManager` keeps
 * matching defaults — keep both in sync if you change either side.
 */

/** Full HD — most universally "standard" desktop preset. */
export const BROWSER_SESSION_VIEWPORT_WIDTH = 1920;
export const BROWSER_SESSION_VIEWPORT_HEIGHT = 1080;
