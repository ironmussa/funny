import { renderMermaidSVG } from 'beautiful-mermaid';
import DOMPurify from 'dompurify';

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

const MERMAID_SANITIZE_CONFIG = {
  // `html` is needed for the XHTML labels mermaid nests in <foreignObject>;
  // DOMPurify still enforces namespaces, so HTML is only accepted inside an
  // HTML integration point.
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  // foreignObject carries node labels; `use` references mermaid's own <defs>
  // symbols (fragment-only hrefs enforced by the hook below).
  ADD_TAGS: ['foreignObject', 'use'],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: [
    'button',
    'embed',
    'form',
    'iframe',
    'input',
    'object',
    'script',
    'select',
    'textarea',
  ],
  FORBID_ATTR: ['action', 'formaction'],
};

let mermaidPurifier: ReturnType<typeof DOMPurify> | null = null;

/** Dedicated instance so the `<use>` hook never affects other sanitizers. */
function getMermaidPurifier(): ReturnType<typeof DOMPurify> {
  if (mermaidPurifier) return mermaidPurifier;
  const purifier = DOMPurify(window);
  purifier.addHook('uponSanitizeAttribute', (node, event) => {
    // <use> may only reference an element inside this SVG.
    if (
      node.nodeName.toLowerCase() === 'use' &&
      (event.attrName === 'href' || event.attrName === 'xlink:href') &&
      !event.attrValue.trim().startsWith('#')
    ) {
      event.keepAttr = false;
    }
  });
  mermaidPurifier = purifier;
  return purifier;
}

/**
 * Security M1: allow-list sanitization of mermaid's SVG output with DOMPurify
 * (SVG + SVG-filter profiles, plus HTML only inside `<foreignObject>`, which
 * can carry labels). All renderer output is treated as untrusted.
 */
export function sanitizeMermaidSvg(svg: string): string {
  if (!svg) return svg;
  const fragment = getMermaidPurifier().sanitize(svg, {
    ...MERMAID_SANITIZE_CONFIG,
    RETURN_DOM_FRAGMENT: true,
  });
  const svgEl = fragment.querySelector('svg');
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

/** Render with app tokens on screen and self-contained colors for PNG export. */
export function renderThreadDiagram(chart: string, target: 'screen' | 'export' = 'screen'): string {
  const svg = renderMermaidSVG(chart, {
    bg: target === 'screen' ? 'hsl(var(--card))' : '#ffffff',
    fg: target === 'screen' ? 'hsl(var(--foreground))' : '#27272a',
    // Set every optional color explicitly: Funny's inherited --muted,
    // --accent and --border tokens contain HSL channels, not CSS colors.
    muted: target === 'screen' ? 'hsl(var(--muted-foreground))' : '#52525b',
    line: target === 'screen' ? 'hsl(var(--muted-foreground))' : '#71717a',
    accent: target === 'screen' ? 'hsl(var(--foreground))' : '#27272a',
    surface: target === 'screen' ? 'hsl(var(--secondary))' : '#f4f4f5',
    border: target === 'screen' ? 'hsl(var(--border))' : '#d4d4d8',
    font: 'Geist Sans',
    transparent: target === 'screen',
  });
  // Funny already bundles its fonts. External font imports also cannot load
  // reliably when the SVG is rasterized through an image for clipboard export.
  return sanitizeMermaidSvg(
    svg
      .replace(/@import\s+url\([^)]*\);?/g, '')
      // Namespace renderer variables without changing the app tokens nested
      // inside hsl(). This also avoids --border referencing itself.
      .replace(/--(bg|fg|line|accent|muted|surface|border)(?=\s*:)/g, '--diagram-$1')
      .replace(/var\(--(bg|fg|line|accent|muted|surface|border)(?=[,)])/g, 'var(--diagram-$1')
      .replace(/hsl\(var\(--diagram-(accent|muted|border)\)\)/g, 'hsl(var(--$1))'),
  );
}
