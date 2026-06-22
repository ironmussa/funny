/**
 * SSRF protection for outbound HTTP fetches.
 *
 * MCP server URLs are user-controlled (written into `.mcp.json` by anyone with
 * project write access). Without a guard, a malicious config could direct the
 * runner's `fetch()` calls at private RFC1918 ranges, link-local addresses, or
 * cloud metadata endpoints (169.254.169.254) — leaking credentials or letting
 * an attacker pivot inside the runner host's network.
 *
 * `assertSafeOutboundUrl` parses + resolves the target URL, then rejects:
 *   - non-http/https schemes
 *   - URLs containing user-info (credentials in the URL)
 *   - any DNS record that points at a loopback / private / link-local IP
 *
 * Callers MUST `await assertSafeOutboundUrl(url)` BEFORE every user-supplied
 * fetch. The function throws on rejection so it short-circuits the request.
 *
 * Security HI-6 — DNS-rebinding residual risk:
 *   The naive flow does `dns.lookup` then `fetch(url)`. A hostile DNS server
 *   can return a public IP on the first resolution and a private IP on the
 *   second, slipping past the validation between validate-time and
 *   connect-time. Three layers mitigate this here:
 *
 *     1. `assertSafeOutboundUrl` writes the validated answer into a short
 *        in-process cache keyed by hostname (`VALIDATED_CACHE_TTL_MS`).
 *     2. Immediately after validation it calls `Bun.dns.prefetch(hostname)`
 *        so Bun's built-in resolver cache is seeded with the *same*
 *        resolution before `fetch` triggers its own internal lookup.
 *     3. `safeFetch` re-checks the cache on every call and, when a previous
 *        validation is still warm, returns a literal-IP URL for HTTP so the
 *        socket connects to the validated address regardless of any
 *        intervening DNS change. HTTPS keeps the original URL because
 *        rewriting it would break SNI / cert verification; we accept that
 *        residual sliver of risk in exchange for not disabling cert
 *        checking, and document the gap here so a future undici-Dispatcher
 *        refactor (tracked as a follow-up) can close it fully.
 */

import { lookup } from 'dns/promises';
import { isIP } from 'net';

import { log } from './logger.js';

const PRIVATE_V4_CIDRS: Array<{ network: number; mask: number; label: string }> = [
  { network: ipv4ToInt('10.0.0.0'), mask: 0xff000000, label: 'rfc1918-10/8' },
  { network: ipv4ToInt('172.16.0.0'), mask: 0xfff00000, label: 'rfc1918-172.16/12' },
  { network: ipv4ToInt('192.168.0.0'), mask: 0xffff0000, label: 'rfc1918-192.168/16' },
  { network: ipv4ToInt('127.0.0.0'), mask: 0xff000000, label: 'loopback' },
  { network: ipv4ToInt('169.254.0.0'), mask: 0xffff0000, label: 'link-local' },
  { network: ipv4ToInt('0.0.0.0'), mask: 0xff000000, label: 'this-network' },
  { network: ipv4ToInt('100.64.0.0'), mask: 0xffc00000, label: 'cgnat' },
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** True if `ip` is an IPv4 address in a private/loopback/link-local range. */
function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return PRIVATE_V4_CIDRS.some((c) => (n & c.mask) >>> 0 === c.network);
}

/** True if `ip` is an IPv6 address in a private/loopback/link-local range. */
function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1') return true;
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
  // IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const v4MappedMatch = lower.match(/^::ffff:([\d.]+)$/);
  if (v4MappedMatch && isIP(v4MappedMatch[1]) === 4) {
    return isPrivateV4(v4MappedMatch[1]);
  }
  return false;
}

/**
 * Always-blocked ranges, even when a caller opts into "LAN OK" mode. These
 * are the actual SSRF pivot vectors — cloud metadata services (IMDS) and
 * the `0.0.0.0` "this network" alias that some IMDS endpoints accept.
 */
const ALWAYS_BLOCKED_V4_CIDRS: Array<{ network: number; mask: number; label: string }> = [
  { network: ipv4ToInt('169.254.0.0'), mask: 0xffff0000, label: 'link-local/cloud-metadata' },
  { network: ipv4ToInt('0.0.0.0'), mask: 0xff000000, label: 'this-network' },
];

function isAlwaysBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return ALWAYS_BLOCKED_V4_CIDRS.some((c) => (n & c.mask) >>> 0 === c.network);
}

function isAlwaysBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower.startsWith('fe80:')) return true; // link-local
  const v4MappedMatch = lower.match(/^::ffff:([\d.]+)$/);
  if (v4MappedMatch && isIP(v4MappedMatch[1]) === 4) return isAlwaysBlockedV4(v4MappedMatch[1]);
  return false;
}

export type OutboundPolicy = {
  /**
   * When true (default), reject any private/loopback/link-local destination.
   * When false, only the always-blocked ranges (cloud metadata + link-local
   * IPv6 + 0.0.0.0) are refused. This is the right policy for outbound
   * fetches whose target is plausibly on the runner's LAN (e.g. a project's
   * configured container launcher running on `192.168.1.50:8080`).
   */
  rejectPrivate?: boolean;
};

/**
 * Per-process cache of validated lookups. Keyed by hostname + policy, with a
 * short TTL so an in-flight `assertSafeOutboundUrl` → `fetch` pair sees a
 * consistent resolution even if the upstream DNS server starts returning a
 * different answer. The TTL is intentionally tiny — we want the result fresh
 * for the immediate fetch, not for unrelated future calls.
 */
const VALIDATED_CACHE_TTL_MS = 2_000;
const validatedCache = new Map<string, { ips: string[]; expiresAt: number }>();

function cacheKey(hostname: string, policy: OutboundPolicy): string {
  return `${policy.rejectPrivate === false ? 'lan' : 'strict'}:${hostname.toLowerCase()}`;
}

function rememberValidated(hostname: string, policy: OutboundPolicy, ips: string[]): void {
  validatedCache.set(cacheKey(hostname, policy), {
    ips,
    expiresAt: Date.now() + VALIDATED_CACHE_TTL_MS,
  });
}

function getValidated(hostname: string, policy: OutboundPolicy): string[] | null {
  const entry = validatedCache.get(cacheKey(hostname, policy));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    validatedCache.delete(cacheKey(hostname, policy));
    return null;
  }
  return entry.ips;
}

function normalizeHostname(parsed: URL): string {
  const rawHost = parsed.hostname;
  return rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
}

function formatIpForUrlHost(ip: string): string {
  return isIP(ip) === 6 ? `[${ip}]` : ip;
}

function withPinnedHttpDestination(
  rawUrl: string,
  init: RequestInit | undefined,
  policy: OutboundPolicy,
): { url: string; init?: RequestInit } {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:') return { url: rawUrl, init };

  const hostname = normalizeHostname(parsed);
  if (isIP(hostname) !== 0) return { url: rawUrl, init };

  const validatedIps = getValidated(hostname, policy);
  const pinnedIp = validatedIps?.[0];
  if (!pinnedIp || isIP(pinnedIp) === 0) return { url: rawUrl, init };

  const pinnedUrl = new URL(rawUrl);
  pinnedUrl.host = `${formatIpForUrlHost(pinnedIp)}${parsed.port ? `:${parsed.port}` : ''}`;

  const headers = new Headers(init?.headers);
  if (!headers.has('host')) headers.set('Host', parsed.host);
  return { url: pinnedUrl.toString(), init: { ...init, headers } };
}

function isBlockedForPolicy(family: 4 | 6, ip: string, policy: OutboundPolicy): string | null {
  // Always-blocked ranges run first; they apply even in LAN-OK mode.
  if (family === 4 && isAlwaysBlockedV4(ip)) return 'cloud-metadata/link-local';
  if (family === 6 && isAlwaysBlockedV6(ip)) return 'link-local/v4-mapped-blocked';
  if (policy.rejectPrivate !== false) {
    if (family === 4 && isPrivateV4(ip)) return 'private/loopback v4';
    if (family === 6 && isPrivateV6(ip)) return 'private/loopback v6';
  }
  return null;
}

/** Reject the URL if it points at a non-public destination. */
export async function assertSafeOutboundUrl(
  rawUrl: string,
  policy: OutboundPolicy = {},
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Refusing non-http(s) URL: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Refusing URL with embedded credentials');
  }

  // `parsed.hostname` keeps surrounding brackets for IPv6 literals; strip
  // them so `isIP` recognizes the address.
  const rawHost = parsed.hostname;
  if (!rawHost) throw new Error('URL has no hostname');
  const hostname = normalizeHostname(parsed);

  // Literal IP — check directly without DNS.
  const literalFamily = isIP(hostname);
  if (literalFamily === 4) {
    const reason = isBlockedForPolicy(4, hostname, policy);
    if (reason) {
      log.warn('SSRF blocked: IPv4 literal', { namespace: 'ssrf-guard', hostname, reason });
      throw new Error(`Refusing address ${hostname}: ${reason}`);
    }
    rememberValidated(hostname, policy, [hostname]);
    return;
  }
  if (literalFamily === 6) {
    const reason = isBlockedForPolicy(6, hostname, policy);
    if (reason) {
      log.warn('SSRF blocked: IPv6 literal', { namespace: 'ssrf-guard', hostname, reason });
      throw new Error(`Refusing address ${hostname}: ${reason}`);
    }
    rememberValidated(hostname, policy, [hostname]);
    return;
  }

  // Hostname — resolve and check every record. If DNS returns 0 records,
  // `fetch` will fail anyway, so the lookup failure is allowed to bubble.
  const records = await lookup(hostname, { all: true });
  for (const r of records) {
    const family = (r.family === 6 ? 6 : 4) as 4 | 6;
    const reason = isBlockedForPolicy(family, r.address, policy);
    if (reason) {
      log.warn('SSRF blocked: hostname resolves to forbidden range', {
        namespace: 'ssrf-guard',
        hostname,
        address: r.address,
        reason,
      });
      throw new Error(`Refusing host ${hostname}: resolves to ${reason}`);
    }
  }
  rememberValidated(
    hostname,
    policy,
    records.map((r) => r.address),
  );

  // Seed Bun's internal resolver cache with the same hostname so the
  // resolution Bun's `fetch` performs internally is most likely to hit our
  // freshly-validated record set rather than a re-query. Best-effort: if
  // the API is unavailable (different Bun version), silently skip.
  try {
    type BunDnsLike = { prefetch?: (h: string) => void } | undefined;
    const bunDns = (globalThis as unknown as { Bun?: { dns?: BunDnsLike } }).Bun?.dns;
    if (bunDns && typeof bunDns.prefetch === 'function') {
      bunDns.prefetch(hostname);
    }
  } catch {
    // ignore — caching is a defense-in-depth measure, not a hard requirement
  }
}

/** Convenience wrapper: validate then fetch. Use for URLs that should ONLY
 * reach public destinations (LLM provider endpoints, MCP discovery, etc.). */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  const policy: OutboundPolicy = {};
  await assertSafeOutboundUrl(url, policy);
  const pinned = withPinnedHttpDestination(url, init, policy);
  return fetch(pinned.url, pinned.init);
}

/**
 * Variant of {@link safeFetch} for URLs the operator opts into reaching
 * the LAN — typically a container launcher (`launcherUrl`) or the
 * `containerUrl` returned by one. Cloud-metadata + 0.0.0.0 + IPv6
 * link-local remain blocked because those aren't legitimate destinations
 * for any of these flows, but RFC1918 / loopback are allowed.
 *
 * Operators who want strict-mode for these too can set the env var:
 *   `FUNNY_STRICT_OUTBOUND_PRIVATE=1`
 */
export async function safeFetchUserUrl(url: string, init?: RequestInit): Promise<Response> {
  const strict = process.env.FUNNY_STRICT_OUTBOUND_PRIVATE === '1';
  const policy: OutboundPolicy = { rejectPrivate: strict };
  await assertSafeOutboundUrl(url, policy);
  const pinned = withPinnedHttpDestination(url, init, policy);
  return fetch(pinned.url, pinned.init);
}
