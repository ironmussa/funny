/**
 * GitHub's REST and GraphQL APIs as the factory calls them: with the Factory
 * App's token for the repository at hand, and every failure an error that
 * names the call. Shared by the issue source and the pull requests adapter.
 */

import { createGithubRest } from '@funny/core/github-app';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import type { IssueSourceError } from '../ports/issue-source.js';
import type { FactoryAppTokens } from './factory-app.js';

export type GithubCallError = IssueSourceError;

export interface FactoryGithub {
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

const fail = (message: string): GithubCallError => ({ message });

export function createFactoryGithub(deps: {
  tokens: FactoryAppTokens;
  fetch?: typeof fetch;
  api?: string;
}): FactoryGithub {
  const rest = createGithubRest({
    fetch: deps.fetch,
    api: deps.api,
    userAgent: 'funny-issue-factory',
  });

  const request = (repo: string, method: string, path: string, body?: unknown) =>
    deps.tokens
      .forRepo(repo)
      .mapErr((e) => fail(e.message))
      .andThen((token) =>
        rest(path, {
          method,
          auth: `token ${token.token}`,
          body: body === undefined ? undefined : JSON.stringify(body),
        }).mapErr((e) => fail(e.message)),
      )
      .andThen((res) =>
        res.ok
          ? okAsync(res)
          : errAsync(fail(`GitHub answered ${res.status} to ${method} ${path}`)),
      );

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
