/**
 * @domain subdomain: Runner Infrastructure
 * @domain subdomain-type: supporting
 * @domain type: domain-service
 * @domain layer: application
 *
 * GitHub tokens for sandbox threads (sandbox-github-app-tokens).
 *
 * A sandbox gets a GitHub App installation token restricted by GitHub to one
 * repository, valid for an hour. Its permissions are capped by the thread
 * owner's own access to that repository, checked with the owner's PAT here on
 * the server: an installation covers a whole account, so without this check
 * any funny user could point a project at a repository the App can reach and
 * get a write token for it. Neither the App's key nor the owner's PAT is ever
 * part of the result.
 */

import { createHash } from 'node:crypto';

import { GITHUB_APP_TOKEN_REUSE_MARGIN_MS } from '@funny/shared/github-app-token';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import type { GithubAppConfig } from './app-config.js';
import { signAppJwt } from './app-jwt.js';

export type AccessLevel = 'write' | 'read';

/** What a sandbox token may do, per the owner's level. A subset of the App's permissions. */
export const SANDBOX_PERMISSIONS: Record<AccessLevel, Record<string, 'read' | 'write'>> = {
  write: {
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',
    workflows: 'write',
    actions: 'read',
    checks: 'read',
    statuses: 'read',
    metadata: 'read',
  },
  read: {
    contents: 'read',
    pull_requests: 'read',
    issues: 'read',
    actions: 'read',
    checks: 'read',
    statuses: 'read',
    metadata: 'read',
  },
};

export type IssueErrorKind = 'not-configured' | 'not-installed' | 'no-access' | 'github-error';
export interface IssueError {
  kind: IssueErrorKind;
  message: string;
}

export interface RepoToken {
  token: string;
  expiresAt: string;
  /** `owner/name`, lowercase. */
  repo: string;
  level: AccessLevel;
}

export interface TokenIssuerDeps {
  app(): ResultAsync<GithubAppConfig | null, string>;
  fetch?: typeof fetch;
  api?: string;
  now?: () => Date;
}

const CACHE_MS = 10 * 60 * 1000;
/** A cached token is reused until this long before it expires (the runner renews inside it). */
const REUSE_MARGIN_MS = GITHUB_APP_TOKEN_REUSE_MARGIN_MS;

const fail = (kind: IssueErrorKind, message: string): IssueError => ({ kind, message });
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function levelOf(permissions: Record<string, boolean> | undefined): AccessLevel | null {
  if (!permissions) return null;
  if (permissions.admin || permissions.maintain || permissions.push) return 'write';
  if (permissions.triage || permissions.pull) return 'read';
  return null;
}

export function createGithubAppTokenIssuer(deps: TokenIssuerDeps) {
  const doFetch = deps.fetch ?? fetch;
  const api = deps.api ?? 'https://api.github.com';
  const now = deps.now ?? (() => new Date());
  const ownerLevels = new Map<string, { level: AccessLevel | null; until: number }>();
  const installations = new Map<string, { id: number | null; until: number }>();
  const tokens = new Map<string, RepoToken>();

  const github = (path: string, init: RequestInit & { auth: string }) =>
    ResultAsync.fromPromise(
      doFetch(`${api}${path}`, {
        ...init,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'funny-sandbox-github-app',
          authorization: init.auth,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
      }),
      (error) => fail('github-error', `GitHub unreachable: ${String(error)}`),
    );

  /** The owner's own level on `repo`, read with their PAT (cached by its hash). */
  function ownerLevel(
    repo: string,
    ownerToken: string,
  ): ResultAsync<AccessLevel | null, IssueError> {
    const key = `${sha256(ownerToken)}:${repo}`;
    const cached = ownerLevels.get(key);
    if (cached && cached.until > now().getTime()) return okAsync(cached.level);
    return github(`/repos/${repo}`, { method: 'GET', auth: `Bearer ${ownerToken}` }).andThen(
      (res): ResultAsync<AccessLevel | null, IssueError> => {
        if (res.status === 404 || res.status === 403 || res.status === 401) {
          ownerLevels.set(key, { level: null, until: now().getTime() + CACHE_MS });
          return okAsync(null);
        }
        if (!res.ok)
          return errAsync(fail('github-error', `GitHub answered ${res.status} for ${repo}`));
        return ResultAsync.fromPromise(
          res.json() as Promise<{ permissions?: Record<string, boolean> }>,
          () => fail('github-error', 'unreadable repository response'),
        ).map((body) => {
          const level = levelOf(body.permissions);
          ownerLevels.set(key, { level, until: now().getTime() + CACHE_MS });
          return level;
        });
      },
    );
  }

  function installationId(repo: string, jwt: string): ResultAsync<number, IssueError> {
    const cached = installations.get(repo);
    if (cached && cached.until > now().getTime()) {
      return cached.id === null
        ? errAsync(fail('not-installed', `The GitHub App is not installed on ${repo}`))
        : okAsync(cached.id);
    }
    return github(`/repos/${repo}/installation`, { method: 'GET', auth: `Bearer ${jwt}` }).andThen(
      (res): ResultAsync<number, IssueError> => {
        if (res.status === 404) {
          installations.set(repo, { id: null, until: now().getTime() + CACHE_MS });
          return errAsync(fail('not-installed', `The GitHub App is not installed on ${repo}`));
        }
        if (!res.ok)
          return errAsync(
            fail('github-error', `GitHub answered ${res.status} for the installation`),
          );
        return ResultAsync.fromPromise(res.json() as Promise<{ id?: number }>, () =>
          fail('github-error', 'unreadable installation response'),
        ).andThen((body) => {
          if (typeof body.id !== 'number')
            return errAsync(fail('github-error', 'installation without id'));
          installations.set(repo, { id: body.id, until: now().getTime() + CACHE_MS });
          return okAsync(body.id);
        });
      },
    );
  }

  function mint(
    repo: string,
    level: AccessLevel,
    jwt: string,
    id: number,
  ): ResultAsync<RepoToken, IssueError> {
    const name = repo.split('/')[1];
    return github(`/app/installations/${id}/access_tokens`, {
      method: 'POST',
      auth: `Bearer ${jwt}`,
      body: JSON.stringify({ repositories: [name], permissions: SANDBOX_PERMISSIONS[level] }),
    }).andThen((res): ResultAsync<RepoToken, IssueError> => {
      if (!res.ok)
        return errAsync(fail('github-error', `GitHub refused the token (${res.status})`));
      return ResultAsync.fromPromise(
        res.json() as Promise<{ token?: string; expires_at?: string }>,
        () => fail('github-error', 'unreadable token response'),
      ).andThen((body) =>
        body.token && body.expires_at
          ? okAsync({ token: body.token, expiresAt: body.expires_at, repo, level })
          : errAsync(fail('github-error', 'token response without token')),
      );
    });
  }

  return {
    /**
     * A token for `repo` (`owner/name`) capped by the owner's access, reused
     * while it has more than ten minutes left.
     */
    issue(repo: string, ownerToken: string | null): ResultAsync<RepoToken, IssueError> {
      const normalized = repo.toLowerCase();
      if (!ownerToken) {
        return errAsync(
          fail('no-access', 'The thread owner has no GitHub token to check access with'),
        );
      }
      return deps
        .app()
        .mapErr((message) => fail('not-configured', message))
        .andThen((app) =>
          app ? okAsync(app) : errAsync(fail('not-configured', 'No GitHub App is connected')),
        )
        .andThen((app) =>
          ownerLevel(normalized, ownerToken).andThen((level) => {
            if (!level) {
              return errAsync(fail('no-access', `The thread owner has no access to ${normalized}`));
            }
            const cacheKey = `${normalized}:${level}`;
            const cached = tokens.get(cacheKey);
            if (cached && Date.parse(cached.expiresAt) - now().getTime() > REUSE_MARGIN_MS) {
              return okAsync(cached);
            }
            const jwt = signAppJwt(app.appId, app.privateKey, now());
            if (jwt.isErr()) return errAsync(fail('not-configured', jwt.error));
            return installationId(normalized, jwt.value)
              .andThen((id) => mint(normalized, level, jwt.value, id))
              .map((token) => {
                tokens.set(cacheKey, token);
                return token;
              });
          }),
        );
    },
  };
}
