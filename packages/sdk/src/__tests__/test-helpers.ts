/**
 * A `fetch` double: the handler answers every request, and `preconnect` (which
 * Bun's `fetch` type also carries) does nothing.
 */
export function fetchDouble(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: () => {} });
}
