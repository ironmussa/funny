/**
 * Helpers for pointing the browser at a file on the runner's filesystem.
 *
 * The runtime exposes `GET /api/files/raw?path=…` which streams raw bytes with
 * an inferred `Content-Type` (see `packages/runtime/src/routes/files.ts`). Local
 * file paths the agent emits — e.g. a `![shot](/abs/path/out.png)` in a chat
 * message, or a binary file opened for preview — are not reachable by the
 * browser directly; they must be routed through this endpoint.
 */

/**
 * True when `src` is already a resource the browser can load on its own — an
 * absolute web URL (`http(s)://`), a protocol-relative URL (`//host/…`), or an
 * inline `data:` / `blob:` URI. These must NOT be rewritten to the raw-file
 * endpoint.
 */
export function isExternalUrl(src: string): boolean {
  return /^(https?:)?\/\//.test(src) || /^(data|blob):/.test(src);
}

/** Build the raw-bytes URL for an absolute filesystem `path` on the runner. */
export function toRawFileSrc(path: string): string {
  return `/api/files/raw?path=${encodeURIComponent(path)}`;
}

/**
 * Resolve a markdown/image `src` to something the browser can render: pass web
 * and data URLs through untouched, route everything else (a local file path)
 * through the raw-file endpoint. Returns `undefined` for an empty/missing src.
 */
export function resolveImageSrc(src?: string): string | undefined {
  if (!src) return undefined;
  if (isExternalUrl(src)) return src;
  return toRawFileSrc(src);
}
