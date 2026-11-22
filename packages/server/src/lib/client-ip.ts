/**
 * The caller's IP, from what the host supplies (docs/plans/
 * cloudflare-portability.md, Phase 1).
 *
 * The host puts the TCP peer address in the Hono env as `IP` on every request
 * (the Bun host passes `server.requestIP(req)`; a Workers host would pass
 * `cf-connecting-ip`). `X-Forwarded-For` is honored only when `TRUST_PROXY`
 * is set, so a client cannot pick its own rate-limit bucket.
 *
 * `TRUST_PROXY` is the number of trusted reverse proxies in front of the
 * server (`true` means one). Each proxy APPENDS the address it received the
 * request from, so only the right-most hops were written by proxies we trust;
 * anything to their left came from the client and can be forged. The caller
 * is therefore the hop `TRUST_PROXY` positions from the right, never the
 * left-most one (issue #204).
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

/**
 * Number of trusted proxy hops from a `TRUST_PROXY` value: `true` is one, a
 * positive integer is that many, anything else (unset, `false`, `0`, junk)
 * trusts no proxy.
 */
export function parseTrustedProxyHops(raw: string | undefined): number {
  const value = raw?.trim().toLowerCase();
  if (!value) return 0;
  if (value === 'true') return 1;
  if (!/^\d+$/.test(value)) return 0;
  return Number.parseInt(value, 10);
}

/** Trusted proxy hops configured for this process (`TRUST_PROXY`). */
export const TRUSTED_PROXY_HOPS = parseTrustedProxyHops(process.env.TRUST_PROXY);

export function clientIp(c: Context, trustedHops: number = TRUSTED_PROXY_HOPS): string | null {
  const peer = (c.env as { IP?: ClientAddress | null } | undefined)?.IP?.address;
  return callerAddress(c.req.raw.headers, peer, trustedHops);
}

/**
 * The same rule for a raw request (paths served before Hono, e.g. the runner
 * carrier): the `X-Forwarded-For` hop `trustedHops` positions from the right
 * (the address the outermost trusted proxy saw), else the peer.
 *
 * With fewer hops than trusted proxies, every hop was written by a trusted
 * proxy, so the left-most one is the caller.
 */
export function callerAddress(
  headers: Headers,
  peer: string | null | undefined,
  trustedHops: number = TRUSTED_PROXY_HOPS,
): string | null {
  if (trustedHops > 0) {
    const hops = (headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    const caller = hops[Math.max(0, hops.length - trustedHops)];
    if (caller) return caller;
  }
  return typeof peer === 'string' && peer.length > 0 ? peer : null;
}
