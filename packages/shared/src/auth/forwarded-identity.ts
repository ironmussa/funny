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
 * computes an HMAC over `userId | role | orgId | orgName | timestamp | nonce`
 * and the runtime recomputes it to verify authenticity. The per-request nonce
 * makes every signed request unique (so legitimate parallel requests in the
 * same millisecond don't collide), and the replay cache keyed on the nonce
 * rejects exact replays inside the skew window.
 *
 * Trust boundary — IMPORTANT. The HMAC key IS the shared secret
 * (`RUNNER_AUTH_SECRET`). So the signature only proves the sender HOLDS the
 * secret; it does NOT distinguish the server from a runner. Anyone holding
 * the secret (the server, OR any runner provisioned with it) can mint a valid
 * signature for an arbitrary `userId`. The signature therefore protects only
 * against callers WITHOUT the secret (e.g. a browser hitting a runner's HTTP
 * port directly). In a multi-runner deployment where every runner shares one
 * `RUNNER_AUTH_SECRET`, a malicious/compromised runner can impersonate any
 * user against another runner's directly-reachable HTTP port. Mitigations:
 * keep runners on the WS tunnel (their HTTP port defaults to loopback under
 * WS_TUNNEL_ONLY) and isolate runners from each other at the network layer.
 *
 * This is an ACCEPTED limitation of the shared-secret model, not a pending fix
 * — see the "Cross-runner trust boundary" note in INSTALL.md. A hard
 * cryptographic boundary would require per-runner signing keys (e.g. the
 * per-runner bearer token) or asymmetric signing; funny does not implement it.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

/** Name of the signature header */
export const SIGNATURE_HEADER = 'X-Forwarded-Signature';
/** Name of the timestamp header (unix ms) */
export const TIMESTAMP_HEADER = 'X-Forwarded-Timestamp';
/** Name of the per-request nonce header */
export const NONCE_HEADER = 'X-Forwarded-Nonce';
/**
 * Share-delegation headers (thread-sharing-steer). Set by the server ONLY after
 * it has verified that `X-Forwarded-User` holds a `steer` grant on the thread.
 * They are part of the signed payload, so a caller without the secret cannot
 * forge them — the runtime trusts them in lieu of a DB lookup it cannot do.
 */
export const SHARE_LEVEL_HEADER = 'X-Forwarded-Share-Level';
export const ON_BEHALF_OF_THREAD_HEADER = 'X-Forwarded-On-Behalf-Of-Thread';

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
 * window. Keyed by the per-request nonce (Security H3) — the proxy generates
 * a fresh UUID for every signed request, so legitimate parallel requests
 * never collide. Only a true replay (same nonce re-presented) is rejected.
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
  /** Share level the user holds on `onBehalfOfThread` (thread-sharing-steer). */
  shareLevel?: string | null;
  /** The thread this request is delegated for (thread-sharing-steer). */
  onBehalfOfThread?: string | null;
}

function canonicalize(identity: ForwardedIdentity, timestamp: number, nonce: string): string {
  const base = [
    identity.userId,
    identity.role ?? '',
    identity.orgId ?? '',
    identity.orgName ?? '',
    String(timestamp),
    nonce,
  ].join('|');
  // Append the share-delegation claim ONLY when present, so the overwhelmingly
  // common non-shared request produces the EXACT legacy canonical string — zero
  // back-compat risk. A steer-delegated request signs (and verifies) the extra
  // suffix, binding the claim to the signature.
  if (identity.shareLevel || identity.onBehalfOfThread) {
    return `${base}|${identity.shareLevel ?? ''}|${identity.onBehalfOfThread ?? ''}`;
  }
  return base;
}

/**
 * Sign a forwarded identity. Returns the headers the proxy should attach.
 *
 * `nonce` defaults to a fresh UUIDv4 per call so that parallel requests
 * sharing a timestamp still produce distinct signatures (otherwise the
 * runtime's replay cache would false-positive on browser refresh bursts).
 */
export function signForwardedIdentity(
  identity: ForwardedIdentity,
  secret: string,
  timestamp: number = Date.now(),
  nonce: string = randomUUID(),
): { signature: string; timestamp: number; nonce: string } {
  const payload = canonicalize(identity, timestamp, nonce);
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return { signature, timestamp, nonce };
}

/**
 * Verify a forwarded identity signature. Returns `true` iff the signature is
 * valid, the timestamp is within the allowed skew, and the nonce has not been
 * seen before inside that window.
 *
 * Uses constant-time comparison to avoid side-channels on the HMAC.
 */
export function verifyForwardedIdentity(
  identity: ForwardedIdentity,
  secret: string,
  signature: string | undefined,
  timestamp: string | number | undefined,
  nonce: string | undefined,
  now: number = Date.now(),
  maxSkewMs: number = SIGNATURE_MAX_SKEW_MS,
): boolean {
  if (!signature || !nonce || timestamp === undefined || timestamp === null) return false;

  const ts = typeof timestamp === 'string' ? Number.parseInt(timestamp, 10) : timestamp;
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > maxSkewMs) return false;

  const expected = createHmac('sha256', secret)
    .update(canonicalize(identity, ts, nonce))
    .digest('hex');

  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;

  // Replay guard: reject a true replay of the same nonce inside the skew
  // window. We register *after* the HMAC verifies so callers can't spam-fill
  // the cache with junk signatures.
  pruneNonceCache(now, maxSkewMs);
  if (nonceCache.has(nonce)) return false;
  evictOldestIfFull();
  nonceCache.set(nonce, ts);
  return true;
}

/**
 * Test-only helper to reset the nonce cache between cases.
 * Not part of the runtime contract — do not call from production code.
 */
export function __resetForwardedIdentityNonceCacheForTests(): void {
  nonceCache.clear();
}
