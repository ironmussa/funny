/**
 * Building blocks shared by the REST-based sandbox provider adapters (change
 * thread-sandboxes): a JSON API client with a per-request timeout, ordered
 * error rules, and the small result shapes every adapter maps the same way.
 * Provider-internal: only adapters under `providers/` import this.
 */

import { errAsync, okAsync, ResultAsync, type Result } from 'neverthrow';

import type {
  ExecResult,
  SandboxError,
  SandboxHandle,
  SandboxProvider,
  TemplateBuildRequest,
  TemplateRef,
} from '../../contract.js';
import { pollUntil } from '../../poll.js';
import { scriptCommand } from '../../runner-install-script.js';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface JsonApiOptions {
  /** Provider name for timeout and fallback messages, e.g. `Boat`. */
  label: string;
  baseUrl: string;
  /** Credential headers sent on every request. */
  authHeaders: Record<string, string>;
  fetch?: Fetch;
  /** Per-request cap, so a hung call cannot block an operation forever. */
  requestTimeoutMs?: number;
  /** Provider error envelope → normalized `SandboxError`. */
  mapError: (res: Response, body: any) => SandboxError;
}

export interface JsonApiCallOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Extends the cap for calls that wait server-side (exec). */
  timeoutMs?: number;
}

export interface JsonApi {
  call(method: string, path: string, options?: JsonApiCallOptions): ResultAsync<any, SandboxError>;
  readonly requestTimeoutMs: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function createJsonApi(options: JsonApiOptions): JsonApi {
  const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const call = (method: string, path: string, opts: JsonApiCallOptions = {}) => {
    const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
    const request = fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        ...options.authHeaders,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return ResultAsync.fromPromise(request, (error): SandboxError => ({
      kind: 'unavailable',
      message:
        error instanceof Error && error.name === 'TimeoutError'
          ? `${options.label} API ${method} ${path} timed out after ${Math.round(timeoutMs / 1000)}s`
          : error instanceof Error
            ? error.message
            : String(error),
    })).andThen((res) =>
      ResultAsync.fromSafePromise(res.json().catch(() => ({}))).andThen((body) =>
        res.ok ? okAsync(body) : errAsync(options.mapError(res, body)),
      ),
    );
  };
  return { call, requestTimeoutMs };
}

/** One error rule: the first rule whose `when` matches maps the error. */
export interface ErrorRule<C> {
  when: (e: C) => boolean;
  map: (e: C) => SandboxError;
}

/** Applies ordered rules; anything unmatched is a generic `provider` error. */
export function mapByRules<C extends { code: string; message: string }>(
  rules: ErrorRule<C>[],
  context: C,
): SandboxError {
  const rule = rules.find((r) => r.when(context));
  if (rule) return rule.map(context);
  const { code, message } = context;
  return { kind: 'provider', message: code ? `${code}: ${message}` : message };
}

/** Any other 401 / 403 is a bad or under-privileged credential. */
export function credentialErrorRule<C extends { status: number; message: string }>(): ErrorRule<C> {
  return {
    when: (e) => e.status === 401 || e.status === 403,
    map: (e) => ({ kind: 'auth', message: e.message }),
  };
}

/** Rules every REST provider shares after its own specific ones. */
export function transientErrorRules<
  C extends { status: number; message: string; retryAfterMs: () => number | undefined },
>(isRateLimit: (e: C) => boolean): ErrorRule<C>[] {
  return [
    {
      when: (e) => e.status === 429 && isRateLimit(e),
      map: (e) => ({ kind: 'rate-limited', message: e.message, retryAfterMs: e.retryAfterMs() }),
    },
    { when: (e) => e.status === 429, map: (e) => ({ kind: 'quota', message: e.message }) },
    {
      when: (e) => e.status >= 500,
      map: (e) => ({ kind: 'unavailable', message: e.message, retryAfterMs: e.retryAfterMs() }),
    },
  ];
}

/** Treats `not-found` as success: deletes are idempotent. */
export function ignoreNotFound(result: ResultAsync<unknown, SandboxError>) {
  return result
    .map(() => undefined)
    .orElse((error) =>
      error.kind === 'not-found' ? okAsync<void, SandboxError>(undefined) : errAsync(error),
    );
}

/** A provider's `exec` response body → `ExecResult`. */
export function execResultFrom(body: any): ExecResult {
  return {
    exitCode: typeof body?.exitCode === 'number' ? body.exitCode : -1,
    stdout: String(body?.stdout ?? ''),
    stderr: String(body?.stderr ?? ''),
  };
}

/** Seconds for a provider-side `exec` wait: at least 1, at most `maxSeconds`. */
export function execTimeoutSeconds(timeoutMs: number | undefined, maxSeconds: number): number {
  return Math.min(maxSeconds, Math.max(1, Math.ceil((timeoutMs ?? 300_000) / 1000)));
}

/** A failed runner install (non-zero exit) as a `provider` error. */
function requireInstallSuccess(result: ExecResult): ResultAsync<void, SandboxError> {
  return result.exitCode === 0
    ? okAsync(undefined)
    : errAsync({
        kind: 'provider',
        message: `runner install failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`,
      });
}

/** A poller bound to an adapter's cadence and injected sleep. */
export function createPoller(pollMs: number, sleep?: (ms: number) => PromiseLike<void>) {
  return <T>(
    what: string,
    timeoutMs: number,
    check: () => ResultAsync<T | null, SandboxError>,
    signal?: AbortSignal,
  ) => pollUntil(check, { what, timeoutMs, intervalMs: pollMs, signal, sleep });
}

export type Poller = ReturnType<typeof createPoller>;

/**
 * Waits for a fresh template machine to run, then runs the runner install
 * script on it; a non-zero exit is a `provider` error.
 */
export function installRunner(
  provider: SandboxProvider,
  handle: SandboxHandle,
  req: TemplateBuildRequest,
  opts: { poll: Poller; readyTimeoutMs?: number; execTimeoutMs: number },
): ResultAsync<void, SandboxError> {
  return opts
    .poll(
      'template sandbox start',
      opts.readyTimeoutMs ?? 5 * 60_000,
      () => provider.status(handle).map((s) => (s.state === 'running' ? true : null)),
      req.signal,
    )
    .andThen(() =>
      provider.exec(handle, scriptCommand(req.installScript, req.scriptEnv), {
        timeoutMs: opts.execTimeoutMs,
      }),
    )
    .andThen(requireInstallSuccess);
}

/**
 * Runs the template build `steps` on a throwaway machine and always destroys
 * it afterwards, whatever the outcome, then surfaces that outcome.
 */
export function withThrowawayMachine(
  handle: SandboxHandle,
  steps: ResultAsync<TemplateRef, SandboxError>,
  destroy: (handle: SandboxHandle) => ResultAsync<void, SandboxError>,
): ResultAsync<TemplateRef, SandboxError> {
  const finish = async (): Promise<Result<TemplateRef, SandboxError>> => {
    const outcome = await steps;
    await destroy(handle);
    return outcome;
  };
  return new ResultAsync(finish());
}
