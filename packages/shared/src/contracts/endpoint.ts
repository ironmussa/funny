/**
 * HTTP contracts shared by the server and the client.
 *
 * An endpoint names its method, its path, the zod schemas of its query and
 * body, and the type of its response. The server registers the route from the
 * endpoint and validates with its schemas; the client builds the URL and types
 * the response from the same object, so neither side can drift from the other.
 *
 * Paths are relative to the group's base (the router mount point under `/api`),
 * which is how the server registers them; `endpointPath` joins the two.
 */

import type { z } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

type AnySchema = z.ZodType;

export interface Endpoint<
  TMethod extends HttpMethod = HttpMethod,
  TPath extends string = string,
  TQuery extends AnySchema | undefined = AnySchema | undefined,
  TBody extends AnySchema | undefined = AnySchema | undefined,
  TResponse = unknown,
> {
  readonly method: TMethod;
  /** The group's mount point, e.g. `/automations`. */
  readonly base: string;
  /** The route within the group, e.g. `/:id/runs`. */
  readonly path: TPath;
  readonly query: TQuery;
  readonly body: TBody;
  /** Type-only: never set at runtime. */
  readonly response?: TResponse;
}

/** Matches every endpoint: each part is covariant, so `unknown` / the widest schema covers it. */
export type AnyEndpoint = Endpoint<
  HttpMethod,
  string,
  AnySchema | undefined,
  AnySchema | undefined,
  unknown
>;

/** `'/:id/runs/:runId'` → `{ id: string; runId: string }`. */
export type PathParams<TPath extends string> =
  TPath extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param]: string } & PathParams<`/${Rest}`>
    : TPath extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : Record<never, never>;

export type ResponseOf<E extends AnyEndpoint> = NonNullable<E['response']>;
export type QueryOf<E extends AnyEndpoint> = E['query'] extends AnySchema
  ? z.output<E['query']>
  : undefined;
export type BodyOf<E extends AnyEndpoint> = E['body'] extends AnySchema
  ? z.output<E['body']>
  : undefined;

/** What a caller passes: path params, query and body, each only when the endpoint has them. */
export type EndpointInput<E extends AnyEndpoint> = (keyof PathParams<E['path']> extends never
  ? unknown
  : { params: PathParams<E['path']> }) &
  (E['query'] extends AnySchema ? { query?: z.input<E['query']> } : unknown) &
  (E['body'] extends AnySchema ? { body: z.input<E['body']> } : unknown);

interface EndpointDefinition<
  TMethod extends HttpMethod,
  TPath extends string,
  TQuery extends AnySchema | undefined,
  TBody extends AnySchema | undefined,
> {
  method: TMethod;
  path: TPath;
  query?: TQuery;
  body?: TBody;
}

/**
 * Endpoints of one router, mounted at `base`. Curried so the response type is
 * written out while the method, path and schemas are inferred:
 *
 * ```ts
 * const api = endpointGroup('/automations');
 * const get = api.endpoint<Automation>()({ method: 'GET', path: '/:id' });
 * ```
 */
export function endpointGroup(base: string) {
  return {
    endpoint:
      <TResponse>() =>
      <
        const TMethod extends HttpMethod,
        const TPath extends string,
        TQuery extends AnySchema | undefined = undefined,
        TBody extends AnySchema | undefined = undefined,
      >(
        definition: EndpointDefinition<TMethod, TPath, TQuery, TBody>,
      ): Endpoint<TMethod, TPath, TQuery, TBody, TResponse> => ({
        method: definition.method,
        base,
        path: definition.path,
        query: definition.query as TQuery,
        body: definition.body as TBody,
      }),
  };
}

/** The endpoint's path under `/api`, with its params filled in and encoded. */
export function endpointPath<E extends AnyEndpoint>(
  endpoint: E,
  params: Record<string, string> = {},
): string {
  const route = endpoint.path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing path param "${name}" for ${endpoint.path}`);
    return encodeURIComponent(value);
  });
  return route === '/' ? endpoint.base : `${endpoint.base}${route}`;
}

/** Query string (with `?`) for the defined values; empty when there are none. */
export function endpointQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  const search = params.toString();
  return search ? `?${search}` : '';
}
