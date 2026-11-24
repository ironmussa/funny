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

export interface BrowserViewportPreset {
  name: string;
  width: number;
  height: number;
}

/**
 * Device sizes the panel's viewport menu offers, in portrait CSS pixels —
 * the same list Chrome DevTools' device toolbar ships.
 */
export const BROWSER_SESSION_PHONE_PRESETS: readonly BrowserViewportPreset[] = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone XR', width: 414, height: 896 },
  { name: 'iPhone 12 Pro', width: 390, height: 844 },
  { name: 'iPhone 14 Pro Max', width: 430, height: 932 },
  { name: 'Pixel 7', width: 412, height: 915 },
  { name: 'Samsung Galaxy S8+', width: 360, height: 740 },
  { name: 'Samsung Galaxy S20 Ultra', width: 412, height: 915 },
  { name: 'Samsung Galaxy A51/71', width: 412, height: 914 },
  { name: 'Galaxy Z Fold 5', width: 344, height: 882 },
  { name: 'Surface Duo', width: 540, height: 720 },
];

export const BROWSER_SESSION_TABLET_PRESETS: readonly BrowserViewportPreset[] = [
  { name: 'iPad Mini', width: 768, height: 1024 },
  { name: 'iPad Air', width: 820, height: 1180 },
  { name: 'iPad Pro', width: 1024, height: 1366 },
  { name: 'Surface Pro 7', width: 912, height: 1368 },
  { name: 'Asus Zenbook Fold', width: 853, height: 1280 },
];
