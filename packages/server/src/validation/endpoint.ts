/**
 * Register a route from a shared contract endpoint (`@funny/shared/contracts/*`).
 *
 * The route takes its method and path from the endpoint, refuses a request
 * without a user (401), runs the route's middleware, validates the query and
 * body with the endpoint's schemas (400 `{ error }`), and only then runs the
 * handler. The handler returns a `Reply` whose body must be the endpoint's
 * response type, so a response that drifts from the contract is a compile
 * error, not a client bug.
 */

import type {
  AnyEndpoint,
  BodyOf,
  PathParams,
  QueryOf,
  ResponseOf,
} from '@funny/shared/contracts/endpoint';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { ServerEnv } from '../lib/types.js';
import { parseJsonBody, parseQuery } from './request.js';

export type ErrorStatus = Exclude<ContentfulStatusCode, 200 | 201>;

export type Reply<T> = { status: 200 | 201; body: T } | { status: ErrorStatus; error: string };

/** `never` for `any`, so an untyped value (e.g. a repository row typed `any`) cannot be a reply. */
type NotAny<T> = 0 extends 1 & T ? never : T;

export const reply = <T>(body: NotAny<T>, status: 200 | 201 = 200): Reply<T> => ({
  status,
  body,
});

export const fail = (status: ErrorStatus, error: string): Reply<never> => ({ status, error });

export interface EndpointRequest<E extends AnyEndpoint> {
  userId: string;
  params: PathParams<E['path']>;
  query: QueryOf<E>;
  body: BodyOf<E>;
}

export interface ServeOptions {
  /**
   * Route middleware (e.g. `requireThreadOwner`), run after the 401 check and
   * before validation, so an inaccessible resource answers 404 before a bad
   * body answers 400.
   */
  middleware?: MiddlewareHandler<ServerEnv>[];
}

const requireUser: MiddlewareHandler<ServerEnv> = async (c, next) => {
  if (!c.get('userId')) return c.json({ error: 'Unauthorized' }, 401);
  return next();
};

export function serveEndpoint<E extends AnyEndpoint>(
  router: Hono<ServerEnv>,
  endpoint: E,
  handler: (request: EndpointRequest<E>, c: Context<ServerEnv>) => Promise<Reply<ResponseOf<E>>>,
  options: ServeOptions = {},
): void {
  router.on(
    endpoint.method,
    endpoint.path,
    requireUser,
    ...(options.middleware ?? []),
    async (c) => {
      const userId = c.get('userId') as string;

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
    },
  );
}
