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

/** Reject the URL if it points at a non-public destination. */
export async function assertSafeOutboundUrl(rawUrl: string): Promise<void> {
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
  const hostname =
    rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;

  // Literal IP — check directly without DNS.
  const literalFamily = isIP(hostname);
  if (literalFamily === 4) {
    if (isPrivateV4(hostname)) {
      log.warn('SSRF blocked: private IPv4 literal', { namespace: 'ssrf-guard', hostname });
      throw new Error(`Refusing private/loopback address: ${hostname}`);
    }
    return;
  }
  if (literalFamily === 6) {
    if (isPrivateV6(hostname)) {
      log.warn('SSRF blocked: private IPv6 literal', { namespace: 'ssrf-guard', hostname });
      throw new Error(`Refusing private/loopback address: ${hostname}`);
    }
    return;
  }

  // Hostname — resolve and check every record. If DNS returns 0 records,
  // `fetch` will fail anyway, so the lookup failure is allowed to bubble.
  const records = await lookup(hostname, { all: true });
  for (const r of records) {
    const bad = r.family === 4 ? isPrivateV4(r.address) : isPrivateV6(r.address);
    if (bad) {
      log.warn('SSRF blocked: hostname resolves to private range', {
        namespace: 'ssrf-guard',
        hostname,
        address: r.address,
      });
      throw new Error(`Refusing host ${hostname}: resolves to private address`);
    }
  }
}

/** Convenience wrapper: validate then fetch. */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  await assertSafeOutboundUrl(url);
  return fetch(url, init);
}
