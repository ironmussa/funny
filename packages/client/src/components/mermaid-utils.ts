import type { MermaidConfig } from 'mermaid';

/**
 * Shared mermaid.initialize() options. `suppressErrorRendering` prevents
 * mermaid from appending the built-in "Syntax error in text" SVG nodes to
 * document.body on failure — those nodes are never removed and stack up,
 * stretching the page with extra scroll.
 */
export function getMermaidInitOptions(theme: 'dark' | 'default'): MermaidConfig {
  return {
    startOnLoad: false,
    theme,
    securityLevel: 'strict',
    suppressErrorRendering: true,
  };
}

/** Remove temp nodes mermaid.render() may leave behind (id, d{id}, i{id}). */
export function removeMermaidRenderArtifacts(renderId: string): void {
  for (const id of [renderId, `d${renderId}`, `i${renderId}`]) {
    document.getElementById(id)?.remove();
  }
}

/**
 * Pure DOM helpers for the mermaid block. Extracted so they can be unit-tested
 * without dragging in React, mermaid, or canvas. Each piece corresponds to a
 * real bug we hit in production:
 *
 * - `sanitizeMermaidSvg`: defense-in-depth XSS scrub for mermaid's SVG output.
 * - `inlineForeignObjects`: rewrites `<foreignObject>` HTML labels as native
 *   SVG `<text>` so an export canvas doesn't get tainted on draw.
 * - `getSvgExportDimensions`: prefers `viewBox` over `width`/`height` because
 *   mermaid emits `width="100%"`, and `parseFloat("100%") === 100` would
 *   produce a 100-pixel-wide PNG with mismatched aspect ratio.
 */

/**
 * Security M1: parse mermaid's SVG output as XML (preserving SVG + XHTML
 * namespaces) and remove the elements/attributes that can carry JS. Mermaid
 * already escapes user input at `securityLevel: 'strict'`, so this is
 * defense-in-depth. We used to delegate to DOMPurify, but its SVG profile
 * stripped HTML content nested inside `<foreignObject>` (which mermaid uses
 * for node labels), leaving every node visually empty.
 */
export function sanitizeMermaidSvg(svg: string): string {
  if (!svg) return svg;
  const template = document.createElement('template');
  template.innerHTML = svg;
  const root = template.content;

  root.querySelectorAll('script').forEach((n) => n.remove());
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if (
        (name === 'href' || name === 'xlink:href' || name === 'src') &&
        value.startsWith('javascript:')
      ) {
        el.removeAttribute(attr.name);
      }
    }
  });

  const svgEl = root.querySelector('svg');
  return svgEl ? svgEl.outerHTML : '';
}

/**
 * Replace mermaid's `<foreignObject>` HTML labels with native SVG `<text>` so
 * the canvas doesn't get tainted on draw. Browsers refuse to export a canvas
 * that ever rendered an `<img>` whose SVG contained foreign HTML — that's why
 * `toBlob()` throws `SecurityError "Tainted canvases may not be exported"`.
 * Only meant for the export path; the on-screen render keeps foreignObject.
 */
export function inlineForeignObjects(svgEl: Element): void {
  const svgNS = 'http://www.w3.org/2000/svg';
  const doc = svgEl.ownerDocument;
  const foreignObjects = Array.from(svgEl.querySelectorAll('foreignObject'));
  for (const fo of foreignObjects) {
    const x = parseFloat(fo.getAttribute('x') ?? '0');
    const y = parseFloat(fo.getAttribute('y') ?? '0');
    const width = parseFloat(fo.getAttribute('width') ?? '0');
    const height = parseFloat(fo.getAttribute('height') ?? '0');
    // Insert a separator where the HTML had a <br> — `textContent` concatenates
    // sibling element text without inserting whitespace, so "line one<br>line
    // two" would otherwise collapse to "line oneline two" in the export.
    fo.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
    const label = (fo.textContent ?? '').replace(/\s+/g, ' ').trim();

    const text = doc.createElementNS(svgNS, 'text');
    text.setAttribute('x', String(x + width / 2));
    text.setAttribute('y', String(y + height / 2));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('font-size', '12');
    text.setAttribute('fill', 'currentColor');
    text.textContent = label;

    fo.parentNode?.replaceChild(text, fo);
  }
}

/**
 * Pick the export dimensions for a mermaid SVG. The viewBox is the source of
 * truth because mermaid sets `width="100%"`/`height="100%"` for responsive
 * in-page rendering, and `parseFloat("100%")` returns 100 — using that as a
 * pixel count produced a tall, narrow PNG with the wrong aspect ratio. Falls
 * back to absolute width/height attrs, then a fixed default.
 */
export function getSvgExportDimensions(svgEl: Element): { w: number; h: number } {
  const widthAttr = svgEl.getAttribute('width');
  const heightAttr = svgEl.getAttribute('height');
  const viewBox = svgEl
    .getAttribute('viewBox')
    ?.split(/[\s,]+/)
    .map(Number);
  const hasViewBox =
    !!viewBox && viewBox.length === 4 && viewBox.every((n) => Number.isFinite(n) && n >= 0);
  const isAbsolute = (attr: string | null) => !!attr && !attr.includes('%');

  const w = hasViewBox ? viewBox![2] : isAbsolute(widthAttr) ? parseFloat(widthAttr!) : 800;
  const h = hasViewBox ? viewBox![3] : isAbsolute(heightAttr) ? parseFloat(heightAttr!) : 600;
  return { w, h };
}
