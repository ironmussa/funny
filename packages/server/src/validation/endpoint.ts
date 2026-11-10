/**
 * Register a route from a shared contract endpoint (`@funny/shared/contracts/*`).
 *
 * The route takes its method and path from the endpoint, refuses a request
 * without a user (401), validates the query and body with the endpoint's
 * schemas (400 `{ error }`), and only then runs the handler. The handler
 * returns a `Reply` whose body must be the endpoint's response type, so a
 * response that drifts from the contract is a compile error, not a client bug.
 */

import type {
  AnyEndpoint,
  BodyOf,
  PathParams,
  QueryOf,
  ResponseOf,
} from '@funny/shared/contracts/endpoint';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { ServerEnv } from '../lib/types.js';
import { parseJsonBody, parseQuery } from './request.js';

export type ErrorStatus = Exclude<ContentfulStatusCode, 200 | 201>;

export type Reply<T> = { status: 200 | 201; body: T } | { status: ErrorStatus; error: string };

export const reply = <T>(body: T, status: 200 | 201 = 200): Reply<T> => ({ status, body });

export const fail = (status: ErrorStatus, error: string): Reply<never> => ({ status, error });

export interface EndpointRequest<E extends AnyEndpoint> {
  userId: string;
  params: PathParams<E['path']>;
  query: QueryOf<E>;
  body: BodyOf<E>;
}

export function serveEndpoint<E extends AnyEndpoint>(
  router: Hono<ServerEnv>,
  endpoint: E,
  handler: (request: EndpointRequest<E>, c: Context<ServerEnv>) => Promise<Reply<ResponseOf<E>>>,
): void {
  router.on(endpoint.method, endpoint.path, async (c) => {
    const userId = c.get('userId') as string | undefined;
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    let query: unknown;
    if (endpoint.query) {
      const parsed = parseQuery(c, endpoint.query);
      if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
      query = parsed.value;
    }

    let body: unknown;
    if (endpoint.body) {
      const parsed = await parseJsonBody(c, endpoint.body);
      if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
      body = parsed.value;
    }

    const result = await handler(
      {
        userId,
        params: c.req.param() as PathParams<E['path']>,
        query: query as QueryOf<E>,
        body: body as BodyOf<E>,
      },
      c,
    );
    return 'error' in result
      ? c.json({ error: result.error }, result.status)
      : c.json(result.body, result.status);
  });
}
