import type { ApiFailure, PortResult } from '@funny/api';

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
