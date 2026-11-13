/**
 * `git clone` with an optional GitHub token that never reaches the argv or the
 * cloned repository's config: the token travels in git's environment as an
 * Authorization header scoped to https://github.com/, so `ps` shows a clean
 * URL, `origin` is stored without credentials, and no other host receives it.
 */
import { dirname } from 'path';

import { internal, processError, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { gitNetwork, ProcessExecutionError } from './process.js';

const GITHUB_HTTPS = 'https://github.com/';

/** Ten minutes: large repositories take a while, but a stuck clone must end. */
const DEFAULT_CLONE_TIMEOUT_MS = 10 * 60_000;

export interface CloneOptions {
  /** GitHub token, sent only to https://github.com/. */
  githubToken?: string | null;
  timeout?: number;
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
export function cloneAuthEnv(
  url: string,
  token: string | null | undefined,
): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
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

/** Clone `url` into `destination` (whose parent must exist). */
export function cloneRepository(
  url: string,
  destination: string,
  options: CloneOptions = {},
): ResultAsync<void, DomainError> {
  const { githubToken, timeout = DEFAULT_CLONE_TIMEOUT_MS, signal, onProgress } = options;
  return ResultAsync.fromPromise(
    gitNetwork(['clone', '--progress', url, destination], {
      cwd: dirname(destination),
      env: cloneAuthEnv(url, githubToken),
      timeout,
      signal,
      onStderr: onProgress ? progressLines(onProgress) : undefined,
    }),
    (error) =>
      error instanceof ProcessExecutionError
        ? processError(error.message, error.exitCode, error.stderr)
        : internal(error instanceof Error ? error.message : String(error)),
  ).map(() => undefined);
}
