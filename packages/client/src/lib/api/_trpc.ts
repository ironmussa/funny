import type { AppRouter } from '@funny/api';
import { TRPC_PATH } from '@funny/api/path';
import type { DomainError } from '@funny/shared/errors';
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { ResultAsync } from 'neverthrow';

import { request } from './_core';

/** A `request()` failure, carried through tRPC's observable to `trpcCall`. */
class RequestFailure extends Error {
  constructor(readonly domainError: DomainError) {
    super(domainError.message);
    this.name = 'RequestFailure';
  }
}

/**
 * Sends each procedure call through `request()`, so auth, telemetry, the
 * circuit breaker, endpoint selection and cancellation apply exactly as for
 * REST calls. One HTTP request per call (no batching) and plain JSON (no
 * transformer), so the wire format matches the REST bodies.
 */
const requestLink: TRPCLink<AppRouter> =
  () =>
  ({ op }) =>
    observable((observer) => {
      if (op.type === 'subscription') {
        observer.error(TRPCClientError.from(new Error('Subscriptions are not supported')));
        return () => undefined;
      }
      const input =
        op.input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(op.input))}`;
      const call =
        op.type === 'query'
          ? request<{ result: { data: unknown } }>(`${TRPC_PATH}/${op.path}${input}`, {
              signal: op.signal ?? undefined,
            })
          : request<{ result: { data: unknown } }>(`${TRPC_PATH}/${op.path}`, {
              method: 'POST',
              body: op.input === undefined ? undefined : JSON.stringify(op.input),
              signal: op.signal ?? undefined,
            });
      void call.match(
        (response) => {
          // A body without `result` (a proxy page, a REST answer) must fail the
          // call: throwing here would leave it pending forever.
          if (!response || typeof response !== 'object' || !('result' in response)) {
            observer.error(
              TRPCClientError.from(
                new RequestFailure({
                  type: 'INTERNAL',
                  message: `Malformed response from ${op.path}`,
                }),
              ),
            );
            return;
          }
          observer.next({ result: { type: 'data', data: response.result.data } });
          observer.complete();
        },
        (error) => observer.error(TRPCClientError.from(new RequestFailure(error))),
      );
      return () => undefined;
    });

/** Typed procedures of the server-answered API (`@funny/api`). Call them through `trpcCall`. */
export const trpc = createTRPCClient<AppRouter>({ links: [requestLink] });

function toDomainError(error: unknown): DomainError {
  const cause = error instanceof TRPCClientError ? error.cause : error;
  if (cause instanceof RequestFailure) return cause.domainError;
  return { type: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
}

/** Runs a procedure call and returns it as a `ResultAsync`, like every other API function. */
export function trpcCall<T>(call: () => Promise<T>): ResultAsync<T, DomainError> {
  return ResultAsync.fromPromise(call(), toDomainError);
}
