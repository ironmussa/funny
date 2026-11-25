/**
 * `git clone` with an optional GitHub token that never reaches the argv or the
 * cloned repository's config: the token travels in git's environment as an
 * Authorization header scoped to https://github.com/, so `ps` shows a clean
 * URL, `origin` is stored without credentials, and no other host receives it.
 */
import { dirname } from 'path';

import { internal, processError, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { gitNetwork, ProcessExecutionError, type EnvOverrides } from './process.js';

const GITHUB_HTTPS = 'https://github.com/';

/**
 * A clone that prints no progress for five minutes is stuck. There is no limit
 * on the whole clone: a large repository takes longer than any fixed limit (a
 * 10-minute one killed a healthy 1.5 GB clone, and git deleted the directory).
 */
const DEFAULT_STALL_TIMEOUT_MS = 5 * 60_000;

export interface CloneOptions {
  /** GitHub token, sent only to https://github.com/. */
  githubToken?: string | null;
  /** Limit on the whole clone, in ms; none by default (0). */
  timeout?: number;
  /** Ends the clone when git prints no progress for this long, in ms (0: never). */
  stallTimeout?: number;
  signal?: AbortSignal;
  /** Each progress line git prints (`Receiving objects:  45% (9/20)`). */
  onProgress?: (line: string) => void;
}

/**
 * The environment that authenticates a clone of `url` with `token`: an
 * `http.<url>.extraHeader` scoped to https://github.com/ when the URL is a
 * GitHub HTTPS URL, nothing otherwise. Prompts are always off, so a missing
 * credential fails instead of hanging.
 */
export function cloneAuthEnv(url: string, token: string | null | undefined): EnvOverrides {
  const env: EnvOverrides = { GIT_TERMINAL_PROMPT: '0' };
  if (!token || !url.startsWith(GITHUB_HTTPS)) return env;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = `http.${GITHUB_HTTPS}.extraHeader`;
  env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  return env;
}

/** Splits streamed stderr into lines (git rewrites progress in place with `\r`). */
function progressLines(onLine: (line: string) => void): (chunk: string) => void {
  let pending = '';
  return (chunk) => {
    pending += chunk;
    const lines = pending.split(/[\r\n]+/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
  };
}

/**
 * An abort signal that fires once `ms` pass without a `touch()`, so the clone
 * ends when it stops making progress rather than after a fixed time.
 */
function stallWatch(ms: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    if (ms > 0) timer = setTimeout(() => controller.abort(), ms);
  };
  touch();
  return { signal: controller.signal, touch, stop: () => clearTimeout(timer) };
}

/** Clone `url` into `destination` (whose parent must exist). */
export function cloneRepository(
  url: string,
  destination: string,
  options: CloneOptions = {},
): ResultAsync<void, DomainError> {
  const {
    githubToken,
    timeout = 0,
    stallTimeout = DEFAULT_STALL_TIMEOUT_MS,
    signal,
    onProgress,
  } = options;
  const stall = stallWatch(stallTimeout);
  const lines = onProgress ? progressLines(onProgress) : undefined;
  return ResultAsync.fromPromise(
    gitNetwork(['clone', '--progress', url, destination], {
      cwd: dirname(destination),
      env: cloneAuthEnv(url, githubToken),
      timeout,
      signal: signal ? AbortSignal.any([signal, stall.signal]) : stall.signal,
      onStderr: (chunk) => {
        stall.touch();
        lines?.(chunk);
      },
    }).finally(stall.stop),
    (error) => {
      if (stall.signal.aborted && !signal?.aborted) {
        const seconds = Math.round(stallTimeout / 1000);
        const message = `Clone stalled: git reported no progress for ${seconds} s`;
        return processError(message, 1, message);
      }
      return error instanceof ProcessExecutionError
        ? processError(error.message, error.exitCode, error.stderr)
        : internal(error instanceof Error ? error.message : String(error));
    },
  ).map(() => undefined);
}
