/**
 * Page expressions for the panel's inspect tool. They call the
 * `window.__funnyElementInfo` helper that `INSPECT_HELPERS` installs.
 */

/** The element at a point. */
export function inspectAtExpression(x: number, y: number): string {
  return `(() => { const el = document.elementFromPoint(${x}, ${y}); return window.__funnyElementInfo ? window.__funnyElementInfo(el) : null; })()`;
}

/**
 * The elements inside a rect: samples a sparse grid (5×5 = 25 points), dedupes
 * by element identity, returns up to 10 by area-of-intersection desc.
 */
export function inspectRectExpression(x: number, y: number, w: number, h: number): string {
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
