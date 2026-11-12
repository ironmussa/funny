import type { ApiFailure, PortResult } from '@funny/api';
import type { Context } from 'hono';

import { fail, type ErrorStatus, type Reply } from '../validation/endpoint.js';

/**
 * A port result as a `serveEndpoint` reply, for the REST routes of a group that
 * is also served over tRPC: the same value, or the same status and message.
 */
export async function answer<T>(result: PortResult<T>, status: 200 | 201 = 200): Promise<Reply<T>> {
  return (await result).match(
    (value): Reply<T> => ({ status, body: value }),
    (error: ApiFailure) => fail(error.status as ErrorStatus, error.message),
  );
}

/** The same, for a plain Hono route (one without a contract): `{ error, code? }` on failure. */
export async function answerJson<T>(
  c: Context,
  result: PortResult<T>,
  status: 200 | 201 = 200,
): Promise<Response> {
  return (await result).match(
    (value) => c.json(value as object, status),
    (error: ApiFailure) =>
      c.json(
        error.code === undefined
          ? { error: error.message }
          : { error: error.message, code: error.code },
        error.status as ErrorStatus,
      ),
  );
}
