import { toRawFileSrc } from '@/lib/raw-file-src';

export function isHtmlFile(filePath: string): boolean {
  return /\.html?$/i.test(filePath);
}

/** Resolve document-relative assets against the runner file, not the app URL. */
function resolveAsset(value: string, filePath: string): string {
  if (!value || value.startsWith('#') || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(value)) {
    return value;
  }
  const base = new URL('file:///');
  base.pathname = filePath.replace(/\\/g, '/');
  const resolved = new URL(value, base);
  let pathname = resolved.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Literal percent signs in local filenames are not necessarily URL escapes.
  }
  const path = pathname.replace(/^\/([a-z]:\/)/i, '$1');
  return new URL(toRawFileSrc(path), window.location.origin).href + resolved.hash;
}

function resolveCss(css: string, filePath: string): string {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote, value: string) => {
    return `url(${JSON.stringify(resolveAsset(value.trim(), filePath))})`;
  });
}

/** Build a static document for a sandboxed iframe; never inject into the app DOM. */
export function buildHtmlPreview(content: string, filePath: string): string {
  const doc = new DOMParser().parseFromString(content, 'text/html');
  // A file must not override URL resolution or navigate the preview automatically.
  doc.querySelectorAll('base, meta[http-equiv]').forEach((node) => node.remove());
  for (const node of doc.querySelectorAll('[src], [href], [poster]')) {
    for (const attribute of ['src', 'href', 'poster']) {
      const value = node.getAttribute(attribute);
      if (value !== null) node.setAttribute(attribute, resolveAsset(value, filePath));
    }
  }
  for (const node of doc.querySelectorAll('[style]')) {
    node.setAttribute('style', resolveCss(node.getAttribute('style')!, filePath));
  }
  for (const node of doc.querySelectorAll('style')) {
    node.textContent = resolveCss(node.textContent ?? '', filePath);
  }
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content =
    "default-src 'none'; img-src http: https: data: blob:; style-src 'unsafe-inline' http: https:; font-src http: https: data:; media-src http: https: data: blob:; base-uri 'none'; form-action 'none'";
  doc.head.prepend(policy);
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}
