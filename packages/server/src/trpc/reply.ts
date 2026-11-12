import type { ApiFailure, PortResult } from '@funny/api';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

type ErrorStatus = Exclude<ContentfulStatusCode, 200 | 201>;

/**
 * A port result as a REST answer, for a route kept for a consumer outside the
 * web client: the same value the tRPC procedure returns, or the same status
 * with `{ error, code? }`.
 */
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
