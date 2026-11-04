/**
 * Per-sandbox tokens for the server's LLM credential proxy (change
 * thread-sandboxes).
 *
 * A sandbox never holds a model credential. Its runner gets one random token,
 * which agents send to `/api/llm-proxy/*` instead of a real key; the server
 * swaps it for the owner's stored credential. Only the SHA-256 is stored, on
 * the thread's sandbox row, so destroying the sandbox revokes the token and a
 * stopped sandbox cannot use it until it is resumed.
 */

import { createHash, randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { threadSandboxes } from '../../db/schema.js';

const TOKEN_PREFIX = 'llmp_';

/** Sandbox states whose agents may call the model. */
const USABLE_STATES = new Set(['connecting', 'bootstrapping', 'running']);

export function hashLlmProxyToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A fresh token (URL-safe, fits the sandbox env file) and its stored hash. */
export function mintLlmProxyToken(): { token: string; hash: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashLlmProxyToken(token) };
}

export interface LlmProxyGrant {
  userId: string;
  threadId: string;
}

/** The sandbox a token belongs to, or null when unknown, revoked or not usable now. */
export function resolveLlmProxyToken(token: string): ResultAsync<LlmProxyGrant | null, string> {
  if (!token.startsWith(TOKEN_PREFIX)) return ResultAsync.fromSafePromise(Promise.resolve(null));
  return ResultAsync.fromPromise(
    db
      .select({
        userId: threadSandboxes.userId,
        threadId: threadSandboxes.threadId,
        state: threadSandboxes.state,
      })
      .from(threadSandboxes)
      .where(eq(threadSandboxes.llmTokenHash, hashLlmProxyToken(token))),
    (error) => (error instanceof Error ? error.message : String(error)),
  ).map(([row]) =>
    row && USABLE_STATES.has(row.state) ? { userId: row.userId, threadId: row.threadId } : null,
  );
}
