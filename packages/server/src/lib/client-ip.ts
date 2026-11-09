/**
 * The caller's IP, from what the host supplies (docs/plans/
 * cloudflare-portability.md, Phase 1).
 *
 * The host puts the TCP peer address in the Hono env as `IP` on every request
 * (the Bun host passes `server.requestIP(req)`; a Workers host would pass
 * `cf-connecting-ip`). `X-Forwarded-For` is honored only when
 * `TRUST_PROXY=true`, so a client cannot pick its own rate-limit bucket.
 *
 * This replaces `getConnInfo` from `hono/bun`, which looks for the Bun server
 * at `c.env.server` (or `c.env` itself). The server's env carries neither, so
 * it always threw and every caller fell back to "no IP": anonymous requests
 * were never rate-limited by IP unless TRUST_PROXY was set.
 */

import type { Context } from 'hono';

/**
 * Caller address of every request on the reverse-link listener (thread
 * sandboxes). It is one value for all sandboxes, so an IP bucket keyed on it
 * is shared by all of them: limit those callers by their authenticated
 * identity instead.
 */
export const REVERSE_LINK_CALLER_ADDRESS = 'sandbox-reverse-link';

/** The per-request peer address a host supplies in the env. */
export interface ClientAddress {
  address?: string;
}

const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

export function clientIp(c: Context, trustProxy: boolean = TRUST_PROXY): string | null {
  const peer = (c.env as { IP?: ClientAddress | null } | undefined)?.IP?.address;
  return callerAddress(c.req.raw.headers, peer, trustProxy);
}

/**
 * The same rule for a raw request (paths served before Hono, e.g. the runner
 * carrier): the first `X-Forwarded-For` hop under `TRUST_PROXY`, else the peer.
 */
export function callerAddress(
  headers: Headers,
  peer: string | null | undefined,
  trustProxy: boolean = TRUST_PROXY,
): string | null {
  if (trustProxy) {
    const first = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (first) return first;
  }
  return typeof peer === 'string' && peer.length > 0 ? peer : null;
}
