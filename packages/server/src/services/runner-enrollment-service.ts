/**
 * Device-link runner enrollment service.
 *
 * Implements the OAuth-2.0-Device-Authorization-Grant-shaped flow that lets a
 * zero-config runner connect without a hand-carried token or shared secret:
 *
 *   1. The runner calls `startEnrollment()` → gets a short `userCode` (for the
 *      human) and a long `pollToken` (kept by the runner; only its hash is
 *      stored).
 *   2. A logged-in user enters the `userCode` in the funny UI and `approve()`s
 *      it. Approval registers a runner under that user and stages the runner's
 *      credentials (bearer + the server's forwarded-identity secret) for one-
 *      time delivery.
 *   3. The runner polls `pollByToken()`; once approved it receives the
 *      credentials exactly once (status pending → approved → consumed).
 *
 * Enrollments self-expire after {@link ENROLLMENT_TTL_MS}; expired rows are
 * swept lazily on each entry point. This module follows the plain-async / throw
 * convention of its sibling runner services (runner-manager, profile-service).
 */

import { createHash, randomInt } from 'crypto';

import type { EnrollmentInfo } from '@funny/shared/runner-protocol';
import { eq, lt, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import { runnerEnrollments } from '../db/schema.js';
import { log } from '../lib/logger.js';
import * as rm from './runner-manager.js';

/** How long a pending enrollment stays valid before it must be restarted. */
export const ENROLLMENT_TTL_MS = 15 * 60 * 1000;
/** Suggested seconds between runner poll attempts. */
export const ENROLLMENT_POLL_INTERVAL_S = 3;
/** Reject a code after this many failed approval attempts (anti-brute-force). */
export const ENROLLMENT_MAX_FAILED_ATTEMPTS = 5;

/**
 * User-code alphabet: uppercase + digits with visually ambiguous characters
 * removed (no O/0, I/1, L). Keeps the code easy to read aloud and type while
 * staying high-entropy enough that, combined with rate limiting, it can't be
 * enumerated within the TTL.
 */
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const USER_CODE_LENGTH = 8; // 31^8 ≈ 8.5e11 combinations

function generateUserCode(): string {
  let raw = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    raw += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  // Group as XXXX-XXXX for readability.
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Normalize user input: uppercase, strip spaces/dashes so "wxyz 1234" matches. */
function normalizeUserCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.length === USER_CODE_LENGTH
    ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
    : input.trim().toUpperCase();
}

function hashPollToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Delete enrollments past their expiry. Best-effort; called on each entry. */
async function sweepExpired(nowIso = new Date().toISOString()): Promise<void> {
  try {
    await db.delete(runnerEnrollments).where(lt(runnerEnrollments.expiresAt, nowIso));
  } catch (err) {
    log.warn('Failed to sweep expired runner enrollments', {
      namespace: 'runner',
      error: String(err),
    });
  }
}

export interface StartEnrollmentResult {
  userCode: string;
  pollToken: string;
  expiresIn: number;
  interval: number;
}

/** Begin a device-link enrollment for a runner (public, unauthenticated). */
export async function startEnrollment(input: {
  hostname: string;
  os: string;
  ip: string;
}): Promise<StartEnrollmentResult> {
  await sweepExpired();

  const nowMs = Date.now();
  const userCode = generateUserCode();
  const pollToken = `rpt_${nanoid(40)}`;
  const expiresAt = new Date(nowMs + ENROLLMENT_TTL_MS).toISOString();

  await db.insert(runnerEnrollments).values({
    id: nanoid(),
    userCode,
    pollTokenHash: hashPollToken(pollToken),
    status: 'pending',
    hostname: input.hostname,
    os: input.os,
    ip: input.ip,
    failedAttempts: 0,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt,
  });

  log.info('Runner enrollment started', {
    namespace: 'runner',
    hostname: input.hostname,
    os: input.os,
  });

  return {
    userCode,
    pollToken,
    expiresIn: Math.floor(ENROLLMENT_TTL_MS / 1000),
    interval: ENROLLMENT_POLL_INTERVAL_S,
  };
}

/** Look up a pending enrollment's metadata for the approval confirm dialog. */
export async function getByUserCode(userCode: string): Promise<EnrollmentInfo | null> {
  await sweepExpired();
  const code = normalizeUserCode(userCode);
  const rows = await db
    .select()
    .from(runnerEnrollments)
    .where(and(eq(runnerEnrollments.userCode, code), eq(runnerEnrollments.status, 'pending')))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    userCode: row.userCode,
    hostname: row.hostname,
    os: row.os,
    ip: row.ip ?? '',
    createdAt: row.createdAt,
  };
}

export type ApproveResult =
  | { ok: true; runnerId: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_approved' | 'locked' };

/**
 * Approve a pending enrollment (authenticated). Registers a runner under the
 * approving user and stages its credentials for one-time delivery via poll.
 */
export async function approve(userCode: string, userId: string): Promise<ApproveResult> {
  await sweepExpired();
  const code = normalizeUserCode(userCode);

  const rows = await db
    .select()
    .from(runnerEnrollments)
    .where(eq(runnerEnrollments.userCode, code))
    .limit(1);
  const row = rows[0];

  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'approved' || row.status === 'consumed') {
    return { ok: false, reason: 'already_approved' };
  }
  if (Date.parse(row.expiresAt) <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  if (row.failedAttempts >= ENROLLMENT_MAX_FAILED_ATTEMPTS) {
    return { ok: false, reason: 'locked' };
  }

  // Register a runner owned by the approving user; reuses any existing runner
  // for this hostname under the same user (runner-manager handles that).
  const { runnerId, token } = await rm.registerRunner(
    { name: `${row.hostname}-funny`, hostname: row.hostname, os: row.os },
    userId,
  );

  await db
    .update(runnerEnrollments)
    .set({
      status: 'approved',
      runnerId,
      runnerToken: token,
      approverUserId: userId,
    })
    .where(eq(runnerEnrollments.id, row.id));

  log.info('Runner enrollment approved', {
    namespace: 'runner',
    runnerId,
    hostname: row.hostname,
    approverUserId: userId,
  });

  return { ok: true, runnerId };
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'approved'; runnerId: string; token: string; forwardedSecret: string }
  | { status: 'invalid' };

/**
 * Poll an enrollment by its poll token (public). Returns `pending` until
 * approved, then the credentials exactly once (the row transitions to
 * `consumed`). Unknown/expired/already-consumed tokens return `invalid`.
 */
export async function pollByToken(pollToken: string): Promise<PollResult> {
  await sweepExpired();
  if (!pollToken) return { status: 'invalid' };

  const rows = await db
    .select()
    .from(runnerEnrollments)
    .where(eq(runnerEnrollments.pollTokenHash, hashPollToken(pollToken)))
    .limit(1);
  const row = rows[0];

  if (!row) return { status: 'invalid' };
  if (Date.parse(row.expiresAt) <= Date.now()) return { status: 'invalid' };
  if (row.status === 'pending') return { status: 'pending' };
  if (row.status !== 'approved' || !row.runnerId || !row.runnerToken) {
    // 'consumed' or a malformed approved row — credentials already delivered.
    return { status: 'invalid' };
  }

  const forwardedSecret = process.env.RUNNER_AUTH_SECRET ?? '';
  if (!forwardedSecret) {
    log.warn('Approved enrollment poll but RUNNER_AUTH_SECRET is unset on the server', {
      namespace: 'runner',
      runnerId: row.runnerId,
    });
  }

  // Deliver once: mark consumed so a re-poll can't re-issue the credentials.
  await db
    .update(runnerEnrollments)
    .set({ status: 'consumed' })
    .where(eq(runnerEnrollments.id, row.id));

  return {
    status: 'approved',
    runnerId: row.runnerId,
    token: row.runnerToken,
    forwardedSecret,
  };
}
