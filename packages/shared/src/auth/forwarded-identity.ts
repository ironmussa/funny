/**
 * HMAC-signed forwarded identity for server → runtime proxy requests.
 *
 * The server proxies authenticated requests to a runtime over either a WS tunnel
 * or direct HTTP. Historically the runtime trusted plaintext `X-Forwarded-User`
 * headers whenever `X-Runner-Auth` matched the shared secret. Any client able to
 * present the shared secret (e.g. leak, reused runner secret, direct connection
 * to a runner's HTTP port) could impersonate any user, including admin.
 *
 * The signature binds the forwarded identity to the shared secret: the server
 * computes an HMAC over `userId | role | orgId | orgName | timestamp` and the
 * runtime recomputes it to verify authenticity. Replay is bounded by rejecting
 * timestamps outside a small skew window.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** Name of the signature header */
export const SIGNATURE_HEADER = 'X-Forwarded-Signature';
/** Name of the timestamp header (unix ms) */
export const TIMESTAMP_HEADER = 'X-Forwarded-Timestamp';

/**
 * Accept signatures within ±60 seconds of the server's clock.
 *
 * The window must be large enough to absorb realistic network + clock skew
 * between server and runner, but small enough that a captured signed request
 * cannot be reused indefinitely. 60s is a safe default; combined with the
 * nonce cache below, the effective replay window for an exact replay is zero.
 */
export const SIGNATURE_MAX_SKEW_MS = 60 * 1000;

/**
 * Nonce cache to reject exact replays of a signed request inside the skew
 * window. Keyed by `${userId}|${timestamp}|${signature}` (Security H3) — a
 * re-presented identical triple is rejected even if it would otherwise still
 * be within skew.
 *
 * The cache is process-local (Map) and self-cleans on each verify call by
 * dropping entries whose timestamp has fallen out of the skew window. A hard
 * cap (`NONCE_CACHE_MAX_ENTRIES`) bounds memory under burst load: when the
 * cap is reached, the oldest insertion is evicted (Map preserves insertion
 * order). Keeping it in-process is sufficient for the single-server topology;
 * if the server ever scales out, this MUST be moved to a shared store
 * (Redis/etc.).
 */
const nonceCache = new Map<string, number>();
const NONCE_CACHE_MAX_ENTRIES = 10_000;

function pruneNonceCache(now: number, maxSkewMs: number): void {
  for (const [key, ts] of nonceCache) {
    if (Math.abs(now - ts) > maxSkewMs) nonceCache.delete(key);
  }
}

function evictOldestIfFull(): void {
  if (nonceCache.size < NONCE_CACHE_MAX_ENTRIES) return;
  // Map iteration is insertion-ordered; the first key is the oldest.
  const oldest = nonceCache.keys().next().value;
  if (oldest !== undefined) nonceCache.delete(oldest);
}

export interface ForwardedIdentity {
  userId: string;
  role?: string | null;
  orgId?: string | null;
  orgName?: string | null;
}

function canonicalize(identity: ForwardedIdentity, timestamp: number): string {
  return [
    identity.userId,
    identity.role ?? '',
    identity.orgId ?? '',
    identity.orgName ?? '',
    String(timestamp),
  ].join('|');
}

/**
 * Sign a forwarded identity. Returns the headers the proxy should attach.
 */
export function signForwardedIdentity(
  identity: ForwardedIdentity,
  secret: string,
  timestamp: number = Date.now(),
): { signature: string; timestamp: number } {
  const payload = canonicalize(identity, timestamp);
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return { signature, timestamp };
}

/**
 * Verify a forwarded identity signature. Returns `true` iff the signature is
 * valid and the timestamp is within the allowed skew.
 *
 * Uses constant-time comparison to avoid side-channels on the HMAC.
 */
export function verifyForwardedIdentity(
  identity: ForwardedIdentity,
  secret: string,
  signature: string | undefined,
  timestamp: string | number | undefined,
  now: number = Date.now(),
  maxSkewMs: number = SIGNATURE_MAX_SKEW_MS,
): boolean {
  if (!signature || timestamp === undefined || timestamp === null) return false;

  const ts = typeof timestamp === 'string' ? Number.parseInt(timestamp, 10) : timestamp;
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > maxSkewMs) return false;

  const expected = createHmac('sha256', secret).update(canonicalize(identity, ts)).digest('hex');

  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;

  // Replay guard: reject an exact reuse of (userId, timestamp, signature)
  // inside the skew window. We register *after* the HMAC verifies so callers
  // can't spam-fill the cache with junk signatures.
  pruneNonceCache(now, maxSkewMs);
  const nonceKey = `${identity.userId}|${ts}|${signature}`;
  if (nonceCache.has(nonceKey)) return false;
  evictOldestIfFull();
  nonceCache.set(nonceKey, ts);
  return true;
}

/**
 * Test-only helper to reset the nonce cache between cases.
 * Not part of the runtime contract — do not call from production code.
 */
export function __resetForwardedIdentityNonceCacheForTests(): void {
  nonceCache.clear();
}
