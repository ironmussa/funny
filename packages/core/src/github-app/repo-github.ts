/**
 * GitHub's REST and GraphQL APIs called with a repository-scoped token: every
 * call asks `tokenFor(repo)` first, and every failure is an error that names
 * the call. The caller decides where the token comes from — the issue factory's
 * own App, or the server's App token capped by a user's access.
 */

import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { createGithubRest } from './installation-tokens.js';

export interface GithubCallError {
  message: string;
  /** GitHub's HTTP status, when it answered. */
  status?: number;
  /** The token source's error kind (e.g. `not-installed`), when the token was refused. */
  kind?: string;
  /** What GitHub said in the body of a refusal (its `message`, or the start of the body). */
  detail?: string;
}

/** Where a repository's token comes from. */
export type RepoTokenSource = (
  repo: string,
) => ResultAsync<string, { message: string; kind?: string }>;

export interface RepoGithub {
  /** A JSON answer (`undefined` for 204). */
  json<T>(
    repo: string,
    method: string,
    path: string,
    body?: unknown,
  ): ResultAsync<T, GithubCallError>;
  /** A text answer (a job log). */
  text(repo: string, path: string): ResultAsync<string, GithubCallError>;
}

const fail = (message: string, status?: number, kind?: string): GithubCallError => ({
  message,
  status,
  kind,
});

/** At most this much of a refusal's body is kept. */
const MAX_DETAIL = 500;

/** What a refusal's body says: its JSON `message` when it has one, else the start of the text. */
function refusalDetail(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      return String(parsed.message).slice(0, MAX_DETAIL);
    }
  } catch {
    // Not JSON: the text itself is the detail.
  }
  return text.slice(0, MAX_DETAIL);
}

export function createRepoGithub(deps: {
  tokenFor: RepoTokenSource;
  fetch?: typeof fetch;
  api?: string;
  userAgent?: string;
}): RepoGithub {
  const rest = createGithubRest({ fetch: deps.fetch, api: deps.api, userAgent: deps.userAgent });

  const request = (repo: string, method: string, path: string, body?: unknown) =>
    deps
      .tokenFor(repo)
      .mapErr((e) => fail(e.message, undefined, e.kind))
      .andThen((token) =>
        rest(path, {
          method,
          auth: `token ${token}`,
          body: body === undefined ? undefined : JSON.stringify(body),
        }).mapErr((e) => fail(e.message)),
      )
      .andThen((res) => {
        if (res.ok) return okAsync(res);
        return ResultAsync.fromSafePromise(res.text().catch(() => '')).andThen((text) => {
          const error = fail(`GitHub answered ${res.status} to ${method} ${path}`, res.status);
          const detail = refusalDetail(text);
          if (detail) error.detail = detail;
          return errAsync(error);
        });
      });

  return {
    json: <T>(repo: string, method: string, path: string, body?: unknown) =>
      request(repo, method, path, body).andThen((res): ResultAsync<T, GithubCallError> => {
        if (res.status === 204) return okAsync(undefined as T);
        return ResultAsync.fromPromise(res.json() as Promise<T>, () =>
          fail(`unreadable answer to ${method} ${path}`),
        );
      }),
    text: (repo, path) =>
      request(repo, 'GET', path).andThen((res) =>
        ResultAsync.fromPromise(res.text(), () => fail(`unreadable answer to GET ${path}`)),
      ),
  };
}
