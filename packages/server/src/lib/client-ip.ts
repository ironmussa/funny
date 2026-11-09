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

/** The per-request peer address a host supplies in the env. */
export interface ClientAddress {
  address?: string;
}

const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

export function clientIp(c: Context, trustProxy: boolean = TRUST_PROXY): string | null {
  if (trustProxy) {
    const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (first) return first;
  }
  const address = (c.env as { IP?: ClientAddress | null } | undefined)?.IP?.address;
  return typeof address === 'string' && address.length > 0 ? address : null;
}
