/**
 * Content policy for runner-supplied response bodies served on the server's
 * origin (security H3). A runner is any user's machine: its bytes must never
 * become an active document or a same-origin script.
 */

/**
 * Content types a runner response may carry through to the browser as-is.
 * None of them is rendered by the browser as an active document or executed
 * as a script on this origin. Everything else — HTML, JavaScript, SVG, XML,
 * CSS, unknown types — is neutralized by `neutralizeRunnerContent` (H3).
 */
const PASSTHROUGH_CONTENT_TYPES = new Set([
  'application/json',
  'application/pdf',
  'application/octet-stream',
  'application/yaml',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/event-stream',
]);

/** Media types that stay renderable but must never be an active document. */
const SANDBOXED_CONTENT_TYPES = new Set(['image/svg+xml']);

function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

function isPassthroughContentType(type: string): boolean {
  if (PASSTHROUGH_CONTENT_TYPES.has(type)) return true;
  if (/^application\/[a-z0-9.+-]+\+json$/.test(type)) return true;
  if (SANDBOXED_CONTENT_TYPES.has(type)) return false;
  return /^(image|audio|video)\/[a-z0-9.+-]+$/.test(type);
}

/**
 * Keep a runner from serving an active document or script on the server's
 * origin. A runner (any user's machine) controls its response bytes; relayed
 * as `text/html` or `application/javascript`, they would run same-origin with
 * the viewer's session and satisfy `script-src 'self'`. Safe types pass
 * through; SVG keeps its type (so `<img>` previews work) but is forced to
 * download and sandboxed on navigation; anything else becomes inert
 * `text/plain` + download. `nosniff` is always set so a passthrough type can
 * never be re-interpreted.
 */
export function neutralizeRunnerContent(headers: Headers): Headers {
  headers.set('X-Content-Type-Options', 'nosniff');
  const type = mediaType(headers.get('content-type'));
  if (!type) {
    // Untyped (e.g. an empty 204): give it an inert type rather than let the
    // browser guess.
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    return headers;
  }
  if (isPassthroughContentType(type)) return headers;
  if (!SANDBOXED_CONTENT_TYPES.has(type)) {
    headers.set('Content-Type', 'text/plain; charset=utf-8');
  }
  headers.set('Content-Disposition', 'attachment');
  headers.set('Content-Security-Policy', 'sandbox');
  return headers;
}

/**
 * A response forced to download (`Content-Disposition: attachment`, e.g. runner
 * content `neutralizeRunnerContent` defused) is also sandboxed, so a browser
 * that renders it anyway gets an opaque origin and no scripts. Applied by the
 * server after `secureHeaders`, which would otherwise replace the CSP.
 */
export function sandboxAttachmentResponse(headers: Headers): void {
  if (!/^\s*attachment/i.test(headers.get('Content-Disposition') ?? '')) return;
  const csp = headers.get('Content-Security-Policy');
  if (csp && /(^|;)\s*sandbox(\s|;|$)/.test(csp)) return;
  headers.set('Content-Security-Policy', csp ? `${csp}; sandbox` : 'sandbox');
}
