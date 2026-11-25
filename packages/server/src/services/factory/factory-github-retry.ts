/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * A GitHub write of the `merge` step tried again when GitHub itself failed
 * (a 5xx, or no answer at all): a failure that says nothing about the pull
 * request, and that used to leave the run waiting for a person. A refusal
 * (4xx) or a token that could not be minted is never tried again.
 */

import type { GithubCallError } from '@funny/core/github-app';
import { retryAsync } from '@funny/shared/async';
import { ResultAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';

/** The wait before each new attempt: three of them, about a minute and a half in all. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000, 60_000];

/**
 * Whether GitHub failed rather than refused: a 5xx, or no usable answer (the
 * network, or a body that could not be read). An error with a `kind` came
 * from the token source, before GitHub was called.
 */
export function isTransientGithubError(error: GithubCallError): boolean {
  if (error.kind !== undefined) return false;
  return error.status === undefined || error.status >= 500;
}

/** A failed attempt, as `retryAsync` sees it (it retries on a rejection). */
class FailedAttempt {
  constructor(readonly error: GithubCallError) {}
}

export interface TransientRetryOptions<T> {
  /** What is tried, for the log. */
  what: string;
  /** Stops the wait between attempts (the run was stopped). */
  signal?: AbortSignal;
  /** The wait before each new attempt (default `TRANSIENT_RETRY_DELAYS_MS`). */
  delaysMs?: readonly number[];
  /** Injected wait, for tests. */
  sleep?: (ms: number) => PromiseLike<void>;
  /**
   * Asked before each new attempt of a call that is not safe to repeat: the
   * result when the failed attempt did take effect on GitHub (it answers an
   * error after doing the work at times), or null to try again. A check that
   * fails counts as null.
   */
  alreadyDone?: () => ResultAsync<T | null, GithubCallError>;
}

/** `call`, tried again after a wait while GitHub fails; its last error when it keeps failing. */
export function retryTransientGithub<T>(
  call: () => ResultAsync<T, GithubCallError>,
  options: TransientRetryOptions<T>,
): ResultAsync<T, GithubCallError> {
  const delays = options.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  const attempt = async (_signal: AbortSignal, number: number): Promise<T> => {
    if (number > 1 && options.alreadyDone) {
      const done = await options.alreadyDone();
      if (done.isOk() && done.value !== null) return done.value;
    }
    const result = await call();
    if (result.isErr()) throw new FailedAttempt(result.error);
    return result.value;
  };
  return ResultAsync.fromPromise(
    retryAsync(attempt, {
      times: delays.length,
      delayMs: (retry) => delays[retry - 1] ?? 0,
      while: (cause) => cause instanceof FailedAttempt && isTransientGithubError(cause.error),
      onRetry: (cause, retry, delayMs) =>
        log.warn('Issue factory: GitHub failed, trying again', {
          namespace: 'factory',
          what: options.what,
          error: cause instanceof FailedAttempt ? cause.error.message : String(cause),
          retry,
          delayMs,
        }),
      sleep: options.sleep,
      signal: options.signal,
    }),
    (cause): GithubCallError =>
      cause instanceof FailedAttempt && !options.signal?.aborted
        ? cause.error
        : { message: 'The run was stopped.' },
  );
}
