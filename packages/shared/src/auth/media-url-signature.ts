/**
 * HMAC-signed direct-media URLs (transport option "C").
 *
 * When a runner advertises a browser-reachable public media URL
 * (`RUNNER_PUBLIC_MEDIA_URL`), the server hands the browser a short-lived signed
 * URL pointing straight at the runner's `/api/files/raw-signed`, so media bytes
 * stream directly from the runner (native `Range`/seek) instead of being
 * buffered through the server's WS tunnel. The signature lets the runner
 * authenticate the request WITHOUT a session cookie or the shared-secret header
 * — neither of which a cross-origin `<img>`/`<video>` request carries.
 *
 * Trust model — identical to {@link signForwardedIdentity}. The HMAC key IS the
 * shared `RUNNER_AUTH_SECRET`, so the signature only proves the minter HOLDS the
 * secret (the server). It does NOT make the token a least-privilege capability:
 * a valid token authorizes fetching `path` as `userId` until `exp`. The runner
 * STILL enforces per-user path scope on redemption (`resolveProjectScope`) — the
 * signature is authentication, not authorization. Tokens are short-lived to
 * bound exposure from URL leakage (logs, referrer). This mirrors the accepted
 * shared-secret limitations documented in `forwarded-identity.ts`.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** Default lifetime of a signed media URL. Short, to bound URL-leak exposure. */
export const MEDIA_URL_DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Query-parameter names carried by a signed media URL. */
export const MEDIA_SIG_PARAMS = {
  path: 'path',
  userId: 'u',
  expires: 'exp',
  signature: 'sig',
} as const;

/** The fields bound by a media URL signature. */
export interface MediaUrlClaim {
  /** Absolute filesystem path on the runner. */
  path: string;
  /** User the token is issued to — re-checked against path scope by the runner. */
  userId: string;
  /** Unix-ms expiry. The runner rejects the token at/after this instant. */
  expires: number;
}

function canonicalize(claim: MediaUrlClaim): string {
  // Order + separator are part of the contract: server and runner MUST agree.
  return [claim.path, claim.userId, String(claim.expires)].join('\n');
}

/** Compute the hex HMAC signature for a media URL claim. */
export function signMediaClaim(claim: MediaUrlClaim, secret: string): string {
  return createHmac('sha256', secret).update(canonicalize(claim)).digest('hex');
}

/**
 * Build a signed direct-media URL: `<base>/api/files/raw-signed?path=…&u=…&exp=…&sig=…`.
 * `base` is the runner's advertised public media URL (no trailing slash needed).
 */
export function buildSignedMediaUrl(base: string, claim: MediaUrlClaim, secret: string): string {
  const signature = signMediaClaim(claim, secret);
  const params = new URLSearchParams({
    [MEDIA_SIG_PARAMS.path]: claim.path,
    [MEDIA_SIG_PARAMS.userId]: claim.userId,
    [MEDIA_SIG_PARAMS.expires]: String(claim.expires),
    [MEDIA_SIG_PARAMS.signature]: signature,
  });
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/api/files/raw-signed?${params.toString()}`;
}

/** The outcome of verifying a signed media URL. */
export type MediaUrlVerifyResult =
  | { ok: true; claim: MediaUrlClaim }
  | { ok: false; reason: 'missing' | 'expired' | 'bad-signature' };

/**
 * Verify the signature + expiry on a runner's `/api/files/raw-signed` request.
 * Returns the validated claim on success. Does NOT check path scope — the caller
 * MUST still authorize `claim.path` for `claim.userId` (the signature is
 * authentication, not authorization). Uses constant-time comparison.
 */
export function verifyMediaUrl(
  params: {
    path: string | undefined | null;
    userId: string | undefined | null;
    expires: string | number | undefined | null;
    signature: string | undefined | null;
  },
  secret: string,
  now: number = Date.now(),
): MediaUrlVerifyResult {
  const { path, userId, expires, signature } = params;
  if (!path || !userId || expires === undefined || expires === null || !signature) {
    return { ok: false, reason: 'missing' };
  }

  const exp = typeof expires === 'string' ? Number.parseInt(expires, 10) : expires;
  if (!Number.isFinite(exp)) return { ok: false, reason: 'missing' };
  if (now >= exp) return { ok: false, reason: 'expired' };

  const claim: MediaUrlClaim = { path, userId, expires: exp };
  const expected = signMediaClaim(claim, secret);

  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad-signature' };
  }
  return { ok: true, claim };
}
