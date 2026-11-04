/**
 * @domain subdomain: Runner Infrastructure
 * @domain subdomain-type: supporting
 * @domain type: domain-service
 * @domain layer: application
 *
 * Provisioning tokens for sandbox runners (change thread-sandboxes).
 *
 * The server mints one token per sandbox, bound to the thread owner and the
 * thread. The sandbox receives it as `RUNNER_PROVISION_TOKEN`; its runner
 * presents it once on `POST /api/runners/register` and becomes the `sandbox`
 * runner of that thread without device-link approval. Tokens are single-use,
 * expire quickly and only their SHA-256 hash is stored.
 */

import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { db } from '../db/index.js';
import { runnerProvisionTokens, threads } from '../db/schema.js';

const RUNNER_PROVISION_TOKEN_TTL_MS = 60 * 60 * 1000;
const TOKEN_PREFIX = 'rprov_';

export type ProvisionTokenError =
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'used' }
  /** The thread is gone or no longer owned by the token's user. */
  | { kind: 'thread-mismatch' }
  | { kind: 'storage'; message: string };

export interface ProvisionGrant {
  tokenId: string;
  userId: string;
  projectId: string | null;
  threadId: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const storageError = (error: unknown): ProvisionTokenError => ({
  kind: 'storage',
  message: error instanceof Error ? error.message : String(error),
});

async function ownedThread(threadId: string, userId: string) {
  const [row] = await db
    .select({ id: threads.id, projectId: threads.projectId })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)));
  return row ?? null;
}

/** Mint a single-use token that enrolls the sandbox runner of `threadId`. */
export function issueThreadProvisionToken(input: {
  userId: string;
  threadId: string;
  ttlMs?: number;
  now?: Date;
}): ResultAsync<{ token: string; expiresAt: string }, ProvisionTokenError> {
  const now = input.now ?? new Date();
  return ResultAsync.fromPromise(ownedThread(input.threadId, input.userId), storageError).andThen(
    (thread) => {
      if (!thread) return errAsync<never, ProvisionTokenError>({ kind: 'thread-mismatch' });
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
      const expiresAt = new Date(
        now.getTime() + (input.ttlMs ?? RUNNER_PROVISION_TOKEN_TTL_MS),
      ).toISOString();
      return ResultAsync.fromPromise(
        db.insert(runnerProvisionTokens).values({
          id: nanoid(),
          tokenHash: hashToken(token),
          userId: input.userId,
          projectId: thread.projectId ?? null,
          threadId: input.threadId,
          createdAt: now.toISOString(),
          expiresAt,
        }),
        storageError,
      ).map(() => ({ token, expiresAt }));
    },
  );
}

/**
 * Consume a token exactly once. A concurrent second consumer of the same token
 * loses the conditional update and gets `used`.
 */
export function consumeProvisionToken(
  token: string,
  now: Date = new Date(),
): ResultAsync<ProvisionGrant, ProvisionTokenError> {
  if (!token.startsWith(TOKEN_PREFIX)) return errAsync({ kind: 'invalid' });
  const lookup = db
    .select()
    .from(runnerProvisionTokens)
    .where(eq(runnerProvisionTokens.tokenHash, hashToken(token)));
  return ResultAsync.fromPromise(lookup, storageError).andThen(([row]) => {
    if (!row) return errAsync<never, ProvisionTokenError>({ kind: 'invalid' });
    if (row.usedAt) return errAsync<never, ProvisionTokenError>({ kind: 'used' });
    if (Date.parse(row.expiresAt) <= now.getTime()) {
      return errAsync<never, ProvisionTokenError>({ kind: 'expired' });
    }
    const claim = db
      .update(runnerProvisionTokens)
      .set({ usedAt: now.toISOString() })
      .where(and(eq(runnerProvisionTokens.id, row.id), isNull(runnerProvisionTokens.usedAt)))
      .returning({ id: runnerProvisionTokens.id });
    return ResultAsync.fromPromise(claim, storageError)
      .andThen((claimed: Array<{ id: string }>) =>
        claimed.length === 0
          ? errAsync<never, ProvisionTokenError>({ kind: 'used' })
          : ResultAsync.fromPromise(ownedThread(row.threadId, row.userId), storageError),
      )
      .andThen((thread) =>
        thread
          ? okAsync<ProvisionGrant, ProvisionTokenError>({
              tokenId: row.id,
              userId: row.userId,
              projectId: row.projectId,
              threadId: row.threadId,
            })
          : errAsync<never, ProvisionTokenError>({ kind: 'thread-mismatch' }),
      );
  });
}

/** Record which runner a consumed token created (audit trail). */
export function recordProvisionedRunner(
  tokenId: string,
  runnerId: string,
): ResultAsync<void, ProvisionTokenError> {
  return ResultAsync.fromPromise(
    db.update(runnerProvisionTokens).set({ runnerId }).where(eq(runnerProvisionTokens.id, tokenId)),
    storageError,
  ).map(() => undefined);
}
