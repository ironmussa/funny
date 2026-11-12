/**
 * Personal API tokens (openspec public-rest-api-v1): a user's credential for
 * the public REST API `/api/v1`, and nothing else. A token is shown once, when
 * it is created; only its SHA-256 hash is stored. It expires, can be revoked,
 * and every rejection of a presented token is audited.
 */

import { createHash, randomBytes } from 'node:crypto';

import {
  DEFAULT_TOKEN_DAYS,
  MAX_TOKEN_DAYS,
  type CreatedPersonalToken,
  type PersonalAccessTokenInfo,
} from '@funny/shared/contracts/personal-tokens';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { ResultAsync } from 'neverthrow';

import { db } from '../db/index.js';
import { personalAccessTokens } from '../db/schema.js';
import { audit } from '../lib/audit.js';

const TOKEN_PREFIX = 'funny_pat_';
/** Characters of the token kept in clear, to tell tokens apart in the list. */
const SHOWN_PREFIX_LENGTH = TOKEN_PREFIX.length + 6;
const DAY_MS = 24 * 60 * 60 * 1000;
/** `last_used_at` is written at most this often per token. */
const LAST_USED_RESOLUTION_MS = 60 * 1000;

type TokenRow = typeof personalAccessTokens.$inferSelect;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const toInfo = (row: TokenRow): PersonalAccessTokenInfo => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
  ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
});

const storageError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Create a token; `token` is the only time its plaintext is available. */
export function createPersonalAccessToken(
  userId: string,
  name: string,
  days: number = DEFAULT_TOKEN_DAYS,
  now: Date = new Date(),
): ResultAsync<CreatedPersonalToken, string> {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const row: TokenRow = {
    id: nanoid(),
    userId,
    name,
    prefix: token.slice(0, SHOWN_PREFIX_LENGTH),
    tokenHash: hashToken(token),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + Math.min(days, MAX_TOKEN_DAYS) * DAY_MS).toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  };
  return ResultAsync.fromPromise(db.insert(personalAccessTokens).values(row), storageError).map(
    () => {
      audit({
        action: 'pat.created',
        actorId: userId,
        detail: `Personal API token "${name}" created`,
        meta: { tokenId: row.id, expiresAt: row.expiresAt },
      });
      return { token, info: toInfo(row) };
    },
  );
}

/** The user's tokens, newest first (never their plaintext or hash). */
export function listPersonalAccessTokens(
  userId: string,
): ResultAsync<PersonalAccessTokenInfo[], string> {
  return ResultAsync.fromPromise(
    db
      .select()
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, userId))
      .orderBy(desc(personalAccessTokens.createdAt)),
    storageError,
  ).map((rows) => rows.map(toInfo));
}

/** Revoke one of the user's tokens; `false` when it is not theirs or already revoked. */
export function revokePersonalAccessToken(
  userId: string,
  tokenId: string,
  now: Date = new Date(),
): ResultAsync<boolean, string> {
  return ResultAsync.fromPromise(
    db
      .update(personalAccessTokens)
      .set({ revokedAt: now.toISOString() })
      .where(
        and(
          eq(personalAccessTokens.id, tokenId),
          eq(personalAccessTokens.userId, userId),
          isNull(personalAccessTokens.revokedAt),
        ),
      )
      .returning({ id: personalAccessTokens.id }),
    storageError,
  ).map((rows) => {
    if (rows.length === 0) return false;
    audit({
      action: 'pat.revoked',
      actorId: userId,
      detail: 'Personal API token revoked',
      meta: { tokenId },
    });
    return true;
  });
}

type Rejection = 'malformed' | 'unknown' | 'revoked' | 'expired';

function reject(reason: Rejection, meta: Record<string, unknown> = {}): null {
  audit({
    action: 'pat.rejected',
    actorId: (meta.userId as string | undefined) ?? null,
    detail: `Personal API token rejected: ${reason}`,
    meta: { reason, ...meta },
  });
  return null;
}

/**
 * The owner of a presented token, or `null` (audited) when it is malformed,
 * unknown, revoked or expired. `authorization` is the request's header.
 */
export async function verifyPersonalAccessToken(
  authorization: string | undefined,
  now: Date = new Date(),
): Promise<string | null> {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  const token = match?.[1];
  if (!token || !token.startsWith(TOKEN_PREFIX)) return reject('malformed');

  const [row] = await db
    .select()
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.tokenHash, hashToken(token)));
  if (!row) return reject('unknown');
  const meta = { tokenId: row.id, userId: row.userId };
  if (row.revokedAt) return reject('revoked', meta);
  if (Date.parse(row.expiresAt) <= now.getTime()) return reject('expired', meta);

  if (!row.lastUsedAt || now.getTime() - Date.parse(row.lastUsedAt) > LAST_USED_RESOLUTION_MS) {
    await db
      .update(personalAccessTokens)
      .set({ lastUsedAt: now.toISOString() })
      .where(eq(personalAccessTokens.id, row.id));
  }
  return row.userId;
}
