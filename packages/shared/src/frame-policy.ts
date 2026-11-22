/**
 * Framing policy shared by the server and the runner CSP (issue #222).
 *
 * The app frames its own raw-file endpoint: `PdfPreview` (`MediaPreview.tsx`)
 * loads a PDF in an `<iframe>` whose src is the same-origin
 * `/api/files/raw?path=…` (`toRawFileSrc`). So both apps allow same-origin
 * frames (`frame-src 'self'`), and the raw-file response alone may be framed by
 * the app (`frame-ancestors 'self'`). Every other response keeps
 * `frame-ancestors 'none'`, so the UI itself still cannot be framed.
 */

/** The same-origin raw-file endpoint the preview iframes load. */
export const RAW_FILE_PATH = '/api/files/raw';

/** `frame-src`: the app may only frame its own origin. */
export const FRAME_SRC = ["'self'"];

/** `frame-ancestors` for a request path: `'self'` for raw files, else `'none'`. */
export function frameAncestorsFor(path: string): string {
  return path === RAW_FILE_PATH ? "'self'" : "'none'";
}
