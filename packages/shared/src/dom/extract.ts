/**
 * Pure DOM-element introspection shared by the browser annotator panel AND
 * the Chrome extension.
 *
 * Two consumers:
 *
 * 1. `packages/runtime/src/services/browser-session-manager.ts` — CDP path
 *    used by the in-app browser panel. Serializes these functions via
 *    `Function.prototype.toString()` and injects the resulting string into
 *    the headless Chromium page context via `Runtime.evaluate`. For this to
 *    work, every exported function MUST be self-contained: no module-level
 *    imports, no closures over module state, no shared constants. Inline
 *    what's needed inside the function body.
 *
 * 2. `packages/chrome-extension/src/content.ts` — content script (isolated
 *    world). Imports the structural helpers (selector, nearby text/elements,
 *    formatters). It keeps its own React component-name detection because
 *    content scripts can't read fibers from the isolated world and must
 *    proxy through a MAIN-world bridge (`page-bridge.ts`).
 *
 * Two output shapes coexist:
 *   - `AnnotationDomInfo` (structured object) — used by the panel
 *   - Markdown-ready strings (`formatStyles`, `formatAccessibility`) — used
 *     by the extension when it emits markdown reports
 */

export interface AnnotationDomInfo {
  selector: string;
  tagName: string;
  testid?: string;
  text?: string;
  classes: string[];
  componentName?: string;
  boundingBox: { x: number; y: number; w: number; h: number };
  computedStyles: Record<string, string>;
  accessibility: { role?: string; ariaLabel?: string; tabIndex?: number };
}

/** Best-effort CSS selector (id wins; falls back to tag + classes + nth-of-type chain, max 5 levels). */
export function cssSelector(el: Element): string {
  if (el.id) return '#' + CSS.escape(el.id);
  const parts: string[] = [];
  let n: Element | null = el;
  while (n && parts.length < 5) {
    let part = n.tagName.toLowerCase();
    if (n.classList.length > 0) {
      part += Array.from(n.classList)
        .slice(0, 2)
        .map((c) => '.' + CSS.escape(c))
        .join('');
    } else if (n.parentElement) {
      const current = n;
      const siblings = Array.from(n.parentElement.children).filter(
        (s) => s.tagName === current.tagName,
      );
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(n) + 1) + ')';
    }
    parts.unshift(part);
    n = n.parentElement;
  }
  return parts.join(' > ');
}

export function pickStyles(cs: CSSStyleDeclaration): Record<string, string> {
  // Keys inlined (instead of a module constant) so `Function.prototype.toString()`
  // on this function returns self-contained JS suitable for injection into a
  // foreign page context (CDP path). Keep this list in sync with what the
  // panel UI surfaces.
  const keys = [
    'color',
    'background-color',
    'font-size',
    'font-family',
    'font-weight',
    'display',
    'position',
    'border',
    'padding',
    'margin',
    'opacity',
  ];
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = cs.getPropertyValue(k);
  return out;
}

/**
 * Same-world framework component detection. Reads React Fiber properties
 * (`__reactFiber*`) and Vue instance markers. Returns `undefined` for host
 * elements (plain HTML tags) and unknown frameworks.
 *
 * In an isolated world (Chrome extension content script) this won't see React
 * fibers — use a MAIN-world bridge there instead.
 */
export function detectFrameworkComponent(el: Element): string | undefined {
  for (const k of Object.keys(el)) {
    if (k.startsWith('__reactFiber')) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let node = (el as any)[k];
      while (node && !node.type) node = node.return;
      if (node && node.type) {
        if (typeof node.type === 'function') {
          return node.type.displayName || node.type.name || undefined;
        }
        if (typeof node.type === 'string') return undefined;
      }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyEl = el as any;
  if (anyEl.__vue__ || anyEl.__vueParentComponent) return 'VueComponent';
  return undefined;
}

/**
 * Full-DOM-path CSS selector — walks up to `<body>` (or `<html>`), filters
 * `funny-*` classes that the extension injects, and always adds nth-of-type
 * when siblings share a tag. Used by the Chrome extension to produce a
 * markdown-friendly selector chain.
 *
 * `cssSelector` (above) and this one differ on purpose: the panel needs a
 * compact selector for display, the extension needs a precise path for
 * regression reproduction in markdown.
 */
export function cssSelectorFull(el: Element, opts?: { excludeClassPrefix?: string }): string {
  const exclude = opts && opts.excludeClassPrefix ? opts.excludeClassPrefix : '';
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.body && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector += '#' + current.id;
      parts.unshift(selector);
      break;
    }
    if (current.className && typeof current.className === 'string') {
      const classes = current.className
        .trim()
        .split(/\s+/)
        .filter((c) => c && (!exclude || !c.startsWith(exclude)))
        .slice(0, 2);
      if (classes.length) selector += '.' + classes.join('.');
    }
    const parent = current.parentElement;
    if (parent) {
      const tagName = current.tagName;
      const siblings = Array.from(parent.children).filter((c) => c.tagName === tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        selector += ':nth-of-type(' + idx + ')';
      }
    }
    parts.unshift(selector);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

/**
 * Computed styles formatted as a `prop: value; prop: value` markdown string.
 * Drops default values (`none`, `normal`, `auto`, `0px`, transparent) to keep
 * the output focused on intentional styling.
 */
export function formatStyles(el: Element): string {
  const cs = window.getComputedStyle(el);
  const props = [
    'display',
    'position',
    'width',
    'height',
    'margin',
    'padding',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'color',
    'background-color',
    'border',
    'border-radius',
    'opacity',
    'overflow',
    'flex-direction',
    'justify-content',
    'align-items',
    'gap',
  ];
  const defaults = ['', 'none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)'];
  const out: string[] = [];
  for (const p of props) {
    const v = cs.getPropertyValue(p);
    if (v && defaults.indexOf(v) === -1) out.push(p + ': ' + v);
  }
  return out.join('; ');
}

/** Accessibility attributes formatted as a `key="value", key="value"` string. */
export function formatAccessibility(el: Element): string {
  const info: string[] = [];
  const role = el.getAttribute('role');
  if (role) info.push('role="' + role + '"');
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) info.push('aria-label="' + ariaLabel + '"');
  const ariaDescribedby = el.getAttribute('aria-describedby');
  if (ariaDescribedby) info.push('aria-describedby="' + ariaDescribedby + '"');
  const tabindex = el.getAttribute('tabindex');
  if (tabindex) info.push('tabindex="' + tabindex + '"');
  const alt = el.getAttribute('alt');
  if (alt) info.push('alt="' + alt + '"');
  return info.join(', ') || 'none';
}

/** Concatenated text of prev sibling | self | next sibling, truncated. */
export function getNearbyText(el: Element): string {
  const texts: string[] = [];
  const prev = el.previousElementSibling;
  const prevText = prev && prev.textContent ? prev.textContent.trim() : '';
  if (prevText) texts.push(prevText.slice(0, 40));
  const ownText = el.textContent ? el.textContent.trim() : '';
  if (ownText) texts.push(ownText.slice(0, 60));
  const next = el.nextElementSibling;
  const nextText = next && next.textContent ? next.textContent.trim() : '';
  if (nextText) texts.push(nextText.slice(0, 40));
  return texts.join(' | ') || 'none';
}

/** Full tag chain from element up to `<html>` (no classes / ids). */
export function getFullPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.documentElement) {
    parts.unshift(current.tagName.toLowerCase());
    current = current.parentElement;
  }
  return parts.join(' > ');
}

/** Brief description of prev / next / parent for context. */
export function getNearbyElements(el: Element): string {
  const items: string[] = [];
  const summarize = (n: Element) => {
    const tag = n.tagName.toLowerCase();
    const cls = n.className && typeof n.className === 'string' ? n.className.split(/\s+/)[0] : '';
    return cls ? tag + '.' + cls : tag;
  };
  const prev = el.previousElementSibling;
  if (prev) items.push('prev: ' + summarize(prev));
  const next = el.nextElementSibling;
  if (next) items.push('next: ' + summarize(next));
  const parent = el.parentElement;
  if (parent) {
    items.push('parent: ' + summarize(parent) + ' (' + parent.children.length + ' children)');
  }
  return items.join(', ') || 'none';
}

export function extractElementInfo(el: Element): AnnotationDomInfo {
  const r = el.getBoundingClientRect();
  const win =
    el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
  return {
    selector: cssSelector(el),
    tagName: el.tagName,
    testid: el.getAttribute('data-testid') || undefined,
    text: (el.textContent || '').trim().slice(0, 80) || undefined,
    classes: Array.from(el.classList),
    boundingBox: {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    },
    computedStyles: pickStyles(win.getComputedStyle(el)),
    accessibility: {
      role: el.getAttribute('role') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      tabIndex: (el as HTMLElement).tabIndex,
    },
    componentName: detectFrameworkComponent(el),
  };
}
