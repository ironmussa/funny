/**
 * Bounded, cancellable polling for sandbox orchestration (change
 * thread-sandboxes), built on the shared Effect-backed `retryAsync`.
 */

import { retryAsync } from '@funny/shared/async';
import { ResultAsync } from 'neverthrow';

import { isRetryableSandboxError, type SandboxError } from './contract.js';

export interface PollOptions {
  /** What is awaited, for timeout messages. */
  what: string;
  timeoutMs: number;
  intervalMs: number;
  signal?: AbortSignal;
  /** Injected wait for deterministic tests. */
  sleep?: (ms: number) => PromiseLike<void>;
}

const NOT_READY = Symbol('not-ready');

const isSandboxError = (value: unknown): value is SandboxError =>
  typeof value === 'object' && value !== null && 'kind' in value && 'message' in value;

/**
 * Poll `check` until it yields a non-null value. Transient provider errors
 * (rate-limited / unavailable) are retried; any other error ends the wait.
 */
export function pollUntil<T>(
  check: () => ResultAsync<T | null, SandboxError>,
  options: PollOptions,
): ResultAsync<T, SandboxError> {
  const attempt = async () => {
    const result = await check();
    if (result.isErr()) throw result.error;
    if (result.value === null) throw NOT_READY;
    return result.value;
  };
  return ResultAsync.fromPromise(
    retryAsync(attempt, {
      delayMs: () => options.intervalMs,
      while: (error) =>
        error === NOT_READY || (isSandboxError(error) && isRetryableSandboxError(error)),
      timeoutMs: options.timeoutMs,
      timeoutError: () => ({ kind: 'unavailable', message: `${options.what} timed out` }),
      sleep: options.sleep,
      signal: options.signal,
    }),
    (error): SandboxError =>
      isSandboxError(error)
        ? error
        : { kind: 'unavailable', message: `${options.what} failed: ${String(error)}` },
  );
}
