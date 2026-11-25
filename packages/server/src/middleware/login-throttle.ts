/**
 * Middleware that wraps Better Auth's sign-in endpoints to apply the
 * per-identifier failure throttle defined in `lib/login-throttle.ts`.
 *
 * Better Auth doesn't (yet) ship a per-account lockout, so we sandwich its
 * handler: read the identifier from the request body, refuse with 429 if
 * the account is currently locked, otherwise pass through and inspect the
 * response status to record success/failure.
 */

import { parseStoredJson } from '@funny/shared/json-validation';
import type { Context, Next } from 'hono';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
} from '../lib/login-throttle.js';
import type { ServerEnv } from '../lib/types.js';
import { isString } from '../lib/value-guards.js';

/**
 * The fields of a sign-in body that can name the account. Each is checked to be
 * a string in `pickIdentifier`; Better Auth validates the body itself.
 */
const signInIdentifierFieldsSchema = z.object({
  username: z.unknown().optional(),
  email: z.unknown().optional(),
  identifier: z.unknown().optional(),
});

type SignInIdentifierFields = z.infer<typeof signInIdentifierFieldsSchema>;

/** Best-effort JSON body read; returns {} on any failure. */
async function readBody(c: Context<ServerEnv>): Promise<SignInIdentifierFields> {
  // The body has to be cloned because Better Auth's handler runs next and
  // needs an unread stream.
  try {
    const cloned = c.req.raw.clone();
    const text = await cloned.text();
    if (!text) return {};
    const parsed = parseStoredJson(signInIdentifierFieldsSchema, text, 'sign-in body');
    return parsed.ok ? parsed.value : {};
  } catch {
    return {};
  }
}

function pickIdentifier(body: SignInIdentifierFields): string | null {
  const fields = ['username', 'email', 'identifier'] as const;
  for (const f of fields) {
    const v = body[f];
    if (isString(v) && v.trim().length > 0) return v;
  }
  return null;
}

export async function loginThrottleMiddleware(c: Context<ServerEnv>, next: Next) {
  // Only apply to actual credential submissions.
  if (c.req.method !== 'POST') return next();

  const body = await readBody(c);
  const identifier = pickIdentifier(body);

  // If no identifier we can't throttle — let Better Auth respond with its
  // own validation error. We still audit the missing-identifier shape so
  // attempted enumeration shows up in the trail.
  if (!identifier) {
    log.warn('Sign-in request without identifier — bypassing throttle', {
      namespace: 'auth',
    });
    return next();
  }

  const status = checkLoginAllowed(identifier);
  if (!status.ok) {
    log.warn('Sign-in rejected: account locked', {
      namespace: 'auth',
      identifier,
      retryAfterSec: status.retryAfterSec,
    });
    return c.json(
      {
        error: 'Too many failed attempts. Try again later.',
        retryAfterSec: status.retryAfterSec,
      },
      429,
      { 'Retry-After': String(status.retryAfterSec) },
    );
  }

  await next();

  // Inspect Better Auth's response to record outcome. Better Auth returns
  // 200 on success and 4xx (typically 401 or 400) on failure.
  const responseStatus = c.res.status;
  if (responseStatus >= 200 && responseStatus < 300) {
    recordLoginSuccess(identifier);
  } else if (responseStatus === 401 || responseStatus === 400 || responseStatus === 403) {
    recordLoginFailure(identifier, { responseStatus });
  }
  // Other statuses (429, 500) are infrastructure failures, not credential
  // failures — leave the counter untouched.
}
