/**
 * Per-account login throttle (Security HI-12).
 *
 * The existing per-IP rate limit on `/api/auth/sign-in/*` (60/min per IP)
 * does not protect against a distributed brute-force spread across many
 * IPs. This module tracks failed-login attempts **per identifier**
 * (username / email, normalised) so a single targeted account is locked
 * out after N failures regardless of how many source IPs the attacker
 * uses.
 *
 * State is per-process and in-memory. For horizontally-scaled deployments
 * the cache loses per-replica isolation — same caveat as the existing
 * forwarded-identity nonce cache (`packages/shared/src/auth/forwarded-
 * identity.ts`). Migrate both to Redis when the topology demands it.
 *
 * Memory is bounded (#197): failures come from unauthenticated callers, so
 * a record that can no longer affect a decision (window over and no active
 * lockout) is dropped, and the map never holds more than
 * `MAX_TRACKED_IDENTIFIERS` records. When the cap is reached the oldest
 * unlocked record goes first, so spraying new identifiers does not lift an
 * existing lockout; only when every tracked record is locked is the oldest
 * lockout dropped, rather than letting the map grow.
 */

import { audit } from './audit.js';

interface FailureRecord {
  /** Count of recorded failures in the current sliding window. */
  failures: number;
  /** Epoch ms of the first failure in this window. */
  windowStartedAt: number;
  /** Epoch ms when the lockout expires (0 = not locked). */
  lockedUntil: number;
}

/** Max failures in a window before lockout kicks in. */
const FAILURE_THRESHOLD = 10;
/** Sliding window length — failures older than this don't count. */
const WINDOW_MS = 15 * 60 * 1000;
/** Lockout duration once the threshold is hit. */
const LOCKOUT_MS = 5 * 60 * 1000;

/** Upper bound on tracked identifiers; the oldest unlocked records go first. */
export const MAX_TRACKED_IDENTIFIERS = 10_000;
/** How often (at most) a full sweep of expired records runs. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/** Insertion order = last-failure order: a record is re-inserted on every failure. */
const records = new Map<string, FailureRecord>();
let lastSweepAt = 0;

function isExpired(rec: FailureRecord, t: number): boolean {
  return t - rec.windowStartedAt >= WINDOW_MS && rec.lockedUntil <= t;
}

function sweepExpired(t: number): void {
  for (const [key, rec] of records) {
    if (isExpired(rec, t)) records.delete(key);
  }
  lastSweepAt = t;
}

/**
 * Make room for one more record by dropping the oldest unlocked one (expired
 * records are unlocked, so they go first in practice). Usually O(1): the
 * oldest record is rarely locked.
 */
function enforceCap(t: number): void {
  if (records.size < MAX_TRACKED_IDENTIFIERS) return;
  for (const [key, rec] of records) {
    if (records.size < MAX_TRACKED_IDENTIFIERS) return;
    if (rec.lockedUntil <= t) records.delete(key);
  }
  // Every remaining record is locked: drop the oldest rather than grow.
  for (const key of records.keys()) {
    if (records.size < MAX_TRACKED_IDENTIFIERS) return;
    records.delete(key);
  }
}

/**
 * Longest key kept per identifier. A real username or email (at most 254
 * characters) fits; longer junk is truncated so the cap bounds memory, not
 * just the entry count.
 */
export const MAX_IDENTIFIER_LENGTH = 320;

function normalize(identifier: string): string {
  return identifier.trim().toLowerCase().slice(0, MAX_IDENTIFIER_LENGTH);
}

function now(): number {
  return Date.now();
}

/**
 * Returns `{ ok: true }` when the identifier may attempt a login, or
 * `{ ok: false, retryAfterSec }` when the account is currently locked.
 * The caller should reject the sign-in with 429 in the locked case.
 */
export function checkLoginAllowed(
  identifier: string,
): { ok: true } | { ok: false; retryAfterSec: number } {
  const key = normalize(identifier);
  const rec = records.get(key);
  if (!rec) return { ok: true };
  const t = now();
  if (isExpired(rec, t)) {
    records.delete(key);
    return { ok: true };
  }
  if (rec.lockedUntil > t) {
    const retryAfterSec = Math.ceil((rec.lockedUntil - t) / 1000);
    return { ok: false, retryAfterSec };
  }
  return { ok: true };
}

/** Record a failed login attempt; locks the account if the threshold is hit. */
export function recordLoginFailure(identifier: string, meta: Record<string, unknown> = {}): void {
  const key = normalize(identifier);
  if (!key) return;
  const t = now();
  if (t - lastSweepAt >= SWEEP_INTERVAL_MS) sweepExpired(t);
  const existing = records.get(key);
  // Refresh window if stale OR start fresh.
  const rec: FailureRecord =
    existing && t - existing.windowStartedAt < WINDOW_MS
      ? existing
      : { failures: 0, windowStartedAt: t, lockedUntil: 0 };
  rec.failures += 1;
  if (rec.failures >= FAILURE_THRESHOLD && rec.lockedUntil < t) {
    rec.lockedUntil = t + LOCKOUT_MS;
    audit({
      action: 'user.login_failed',
      actorId: null,
      detail: `Account locked after ${rec.failures} failed login attempts`,
      meta: { identifier: key, lockoutMs: LOCKOUT_MS, ...meta },
    });
  } else {
    audit({
      action: 'user.login_failed',
      actorId: null,
      detail: `Failed login attempt (${rec.failures}/${FAILURE_THRESHOLD})`,
      meta: { identifier: key, ...meta },
    });
  }
  // Re-insert so the map stays ordered by last failure (oldest first).
  records.delete(key);
  enforceCap(t);
  records.set(key, rec);
}

/** Record a successful login; clears the failure counter for this identifier. */
export function recordLoginSuccess(identifier: string): void {
  const key = normalize(identifier);
  records.delete(key);
  audit({
    action: 'user.login',
    actorId: null,
    detail: 'Login succeeded',
    meta: { identifier: key },
  });
}

/** Test helper — reset all state. Do not call from production code. */
export function _resetLoginThrottle(): void {
  records.clear();
  lastSweepAt = 0;
}

/** Test helper — number of tracked identifiers. Do not call from production code. */
export function _loginThrottleSize(): number {
  return records.size;
}
