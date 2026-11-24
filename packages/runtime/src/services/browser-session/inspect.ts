/**
 * Element inspection scripts run in a browser session's page. Split out of
 * browser-session-manager.ts.
 */

import {
  cssSelector,
  detectFrameworkComponent,
  extractElementInfo,
  pickStyles,
} from '@funny/shared/dom/extract';

/**
 * Per-session inspect helpers — injected into Runtime.evaluate calls.
 *
 * Source of truth: `@funny/shared/dom/extract`. We serialize the TS functions
 * with `Function.prototype.toString()` (Bun strips type annotations, returning
 * post-transpile JS) and wrap them in an IIFE that exposes them as window
 * globals. The same code runs in the client (iframe path) via direct import —
 * eliminating drift between the two paths.
 */
export const INSPECT_HELPERS = `
(() => {
  if (window.__funnyInspectInstalled) return;
  window.__funnyInspectInstalled = true;
  ${cssSelector.toString()}
  ${pickStyles.toString()}
  ${detectFrameworkComponent.toString()}
  ${extractElementInfo.toString()}
  window.__funnyCssSelector = cssSelector;
  window.__funnyPickStyles = pickStyles;
  window.__funnyDetectFramework = detectFrameworkComponent;
  window.__funnyElementInfo = extractElementInfo;
})();
`.trim();

/** The element at a point, as `__funnyElementInfo` describes it. */
export function inspectPointScript(x: number, y: number): string {
  return `(() => { const el = document.elementFromPoint(${x}, ${y}); return window.__funnyElementInfo ? window.__funnyElementInfo(el) : null; })()`;
}

/**
 * Sample a sparse grid inside the rect (5×5 = 25 points), dedupe by
 * element identity, return up to 10 by area-of-intersection desc.
 */
export function inspectRectScript(x: number, y: number, w: number, h: number): string {
  return `
        (() => {
          const X=${x}, Y=${y}, W=${w}, H=${h};
          const found = new Map();
          const stepX = W / 4, stepY = H / 4;
          for (let i = 0; i <= 4; i++) {
            for (let j = 0; j <= 4; j++) {
              const el = document.elementFromPoint(X + i * stepX, Y + j * stepY);
              if (el && !found.has(el)) found.set(el, true);
            }
          }
          const elements = [];
          for (const el of found.keys()) {
            const info = window.__funnyElementInfo(el);
            if (!info) continue;
            const ix = Math.max(0, Math.min(X + W, info.boundingBox.x + info.boundingBox.w) - Math.max(X, info.boundingBox.x));
            const iy = Math.max(0, Math.min(Y + H, info.boundingBox.y + info.boundingBox.h) - Math.max(Y, info.boundingBox.y));
            const inter = ix * iy;
            if (inter <= 0) continue;
            elements.push({ ...info, intersectionArea: inter });
          }
          return elements.sort((a, b) => b.intersectionArea - a.intersectionArea).slice(0, 10);
        })()
        `;
}
