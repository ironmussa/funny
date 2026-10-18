/**
 * MCP OAuth `state` bound to the runner that started the flow (H3 / M3).
 *
 * The OAuth provider redirects the browser to the unauthenticated
 * `/api/mcp/oauth/callback`, so the callback carries no session. To route it
 * deterministically, the SERVER (not the runner) mints the `state` when it
 * proxies the authenticated `POST /api/mcp/oauth/start`: an HMAC over
 * `{ userId, runnerId, expiry, nonce }` with a key that never leaves this
 * process. The runtime uses that value as its pending-state key, the provider
 * echoes it back, and `withOAuthCallbackRunner` (runner-for.ts) verifies it and
 * certifies ONLY the bound runner, re-checking its owner. No "any runner"
 * fallback exists.
 *
 * Minting demands a `RunnerFor<A, R>` proof, so a state can only bind a runner
 * that was certified for that user. Verification is internal to the prover.
 *
 * The key is random per server process: a restart invalidates in-flight flows
 * (the user retries, and the runtime's pending state is in-memory anyway). The
 * server already assumes a single instance (see automation-scheduler).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { parseStoredJson } from '@funny/shared/json-validation';
import type { Named } from '@gdp-ts/core';
import { z } from 'zod';

import type { RunnerActor, RunnerId } from './runner-actor.js';
import type { RunnerFor } from './runner-for.js';

/** Header the server uses to hand the minted state to the runtime's `/oauth/start`. */
export const OAUTH_STATE_HEADER = 'X-Funny-OAuth-State';

/** Matches the runtime's pending-state TTL. */
const STATE_TTL_MS = 10 * 60 * 1000;
const VERSION = 'v1';
const STATE_KEY = randomBytes(32);

export interface OAuthCallbackBinding {
  readonly userId: string;
  readonly runnerId: string;
}

const statePayloadSchema = z.object({
  u: z.string().min(1),
  r: z.string().min(1),
  e: z.number(),
  n: z.string(),
});
type StatePayload = z.infer<typeof statePayloadSchema>;

function mac(body: string): Buffer {
  return createHmac('sha256', STATE_KEY).update(`${VERSION}.${body}`).digest();
}

/** Bind a new OAuth `state` to a runner certified for the actor. */
export function mintOAuthCallbackState<A, R>(
  actor: Named<A, RunnerActor>,
  runner: Named<R, RunnerId>,
  _proof: RunnerFor<A, R>,
  now: number = Date.now(),
): string {
  const payload: StatePayload = {
    u: actor.value.userId,
    r: runner.value,
    e: now + STATE_TTL_MS,
    n: randomBytes(16).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${VERSION}.${body}.${mac(body).toString('base64url')}`;
}

/**
 * The binding a state was minted for, or null when it is malformed, forged,
 * or expired. Only the prover in `runner-for.ts` calls this.
 */
export function verifyOAuthCallbackState(
  state: string | undefined | null,
  now: number = Date.now(),
): OAuthCallbackBinding | null {
  if (typeof state !== 'string' || state.length > 1024) return null;
  const parts = state.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, body, sig] = parts;
  const expected = mac(body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const parsed = parseStoredJson(
    statePayloadSchema,
    Buffer.from(body, 'base64url').toString('utf8'),
    'OAuth callback state',
  );
  if (!parsed.ok || parsed.value.e < now) return null;
  return { userId: parsed.value.u, runnerId: parsed.value.r };
}
