import type { DomainError } from '@funny/shared/errors';
import { QueryClient } from '@tanstack/query-core';
import type { ResultAsync } from 'neverthrow';

/**
 * Request cache shared by every collection loader in a `DataLayer`.
 *
 * query-core gives us in-flight de-duplication and freshness (`staleTime`)
 * for every list fetch, replacing the per-store `loading`/`loadedAt` maps
 * (`stale-fetch.ts`, the `pid|archived` in-flight map in `thread-store`).
 * Retries are off: failures surface exactly as they did before the data
 * layer existed, and callers decide whether to retry.
 */

/** Default freshness period, matching `stale-fetch.ts`. */
const DEFAULT_STALE_MS = 60_000;

export function createDataQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: DEFAULT_STALE_MS,
        gcTime: 5 * 60_000,
      },
    },
  });
}

/** Rejection reason for a query whose API call returned `err`. Carries the original `DomainError`. */
export class DataRequestError extends Error {
  readonly domainError: DomainError;

  constructor(domainError: DomainError) {
    super(domainError.message);
    this.name = 'DataRequestError';
    this.domainError = domainError;
  }
}

/**
 * Adapt a neverthrow `ResultAsync` to the throwing Promise a `queryFn`
 * expects. The inverse adapter lives at each action's public boundary.
 */
export async function unwrapResult<T>(result: ResultAsync<T, DomainError>): Promise<T> {
  const settled = await result;
  if (settled.isErr()) throw new DataRequestError(settled.error);
  return settled.value;
}

/** Map any rejection back to a `DomainError` for neverthrow callers. */
export function toDomainError(error: unknown): DomainError {
  if (error instanceof DataRequestError) return error.domainError;
  const message = error instanceof Error ? error.message : String(error);
  return { type: 'INTERNAL', message };
}
