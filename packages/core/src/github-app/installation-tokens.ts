/**
 * GitHub App installation tokens (sandbox-github-app-tokens), shared by the
 * funny server and the issue factory.
 *
 * A token is restricted by GitHub to ONE repository and to the permission set
 * the caller asks for, and lives an hour. Who may ask for what is the caller's
 * decision: the server caps a sandbox token by the thread owner's own access;
 * the issue factory, whose App is installed only on the repositories it
 * watches, uses the App's write set. The App's key is never part of a result.
 */

import { GITHUB_APP_TOKEN_REUSE_MARGIN_MS } from '@funny/shared/github-app-token';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { signAppJwt } from './app-jwt.js';

export type GithubPermissionLevel = 'read' | 'write';
/** GitHub App permissions, e.g. `{ contents: 'write', metadata: 'read' }`. */
export type GithubPermissions = Record<string, GithubPermissionLevel>;

export interface GithubAppCredentials {
  appId: string;
  privateKey: string;
}

export type GithubAppErrorKind = 'not-configured' | 'not-installed' | 'github-error';
export interface GithubAppError {
  kind: GithubAppErrorKind;
  message: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
  /** `owner/name`, lowercase. */
  repo: string;
}

export interface GithubRestOptions {
  fetch?: typeof fetch;
  /** API root, `https://api.github.com` by default. */
  api?: string;
  userAgent?: string;
}

export type GithubRest = (
  path: string,
  init: { method: string; auth: string; body?: string },
) => ResultAsync<Response, GithubAppError>;

/** A GitHub REST caller with GitHub's headers; a network failure is a `github-error`. */
export function createGithubRest(options: GithubRestOptions = {}): GithubRest {
  const doFetch = options.fetch ?? fetch;
  const api = options.api ?? 'https://api.github.com';
  const userAgent = options.userAgent ?? 'funny-github-app';
  return (path, init) =>
    ResultAsync.fromPromise(
      doFetch(`${api}${path}`, {
        method: init.method,
        body: init.body,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': userAgent,
          authorization: init.auth,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
      }),
      (error) => githubAppError('github-error', `GitHub unreachable: ${String(error)}`),
    );
}

export interface InstallationTokenIssuerOptions extends GithubRestOptions {
  now?: () => Date;
}

export interface InstallationTokenRequest {
  app: GithubAppCredentials;
  /** `owner/name`; compared case-insensitively. */
  repo: string;
  permissions: GithubPermissions;
}

export interface InstallationTokenIssuer {
  /**
   * A token for `repo` with `permissions`, reused while it has more than
   * `GITHUB_APP_TOKEN_REUSE_MARGIN_MS` left.
   */
  issue(request: InstallationTokenRequest): ResultAsync<InstallationToken, GithubAppError>;
}

/** How long an installation lookup (found or missing) is remembered. */
const INSTALLATION_CACHE_MS = 10 * 60 * 1000;

export const githubAppError = (kind: GithubAppErrorKind, message: string): GithubAppError => ({
  kind,
  message,
});

const permissionsKey = (permissions: GithubPermissions) =>
  Object.keys(permissions)
    .sort()
    .map((name) => `${name}=${permissions[name]}`)
    .join(',');

export function createInstallationTokenIssuer(
  options: InstallationTokenIssuerOptions = {},
): InstallationTokenIssuer {
  const github = createGithubRest(options);
  const now = options.now ?? (() => new Date());
  const installations = new Map<string, { id: number | null; until: number }>();
  const tokens = new Map<string, InstallationToken>();

  const notInstalled = (repo: string) =>
    githubAppError('not-installed', `The GitHub App is not installed on ${repo}`);

  function installationId(
    appId: string,
    repo: string,
    jwt: string,
  ): ResultAsync<number, GithubAppError> {
    const key = `${appId}:${repo}`;
    const cached = installations.get(key);
    if (cached && cached.until > now().getTime()) {
      return cached.id === null ? errAsync(notInstalled(repo)) : okAsync(cached.id);
    }
    return github(`/repos/${repo}/installation`, { method: 'GET', auth: `Bearer ${jwt}` }).andThen(
      (res): ResultAsync<number, GithubAppError> => {
        if (res.status === 404) {
          installations.set(key, { id: null, until: now().getTime() + INSTALLATION_CACHE_MS });
          return errAsync(notInstalled(repo));
        }
        if (!res.ok) {
          return errAsync(
            githubAppError('github-error', `GitHub answered ${res.status} for the installation`),
          );
        }
        return ResultAsync.fromPromise(res.json() as Promise<{ id?: number }>, () =>
          githubAppError('github-error', 'unreadable installation response'),
        ).andThen((body) => {
          if (typeof body.id !== 'number') {
            return errAsync(githubAppError('github-error', 'installation without id'));
          }
          installations.set(key, { id: body.id, until: now().getTime() + INSTALLATION_CACHE_MS });
          return okAsync(body.id);
        });
      },
    );
  }

  function mint(
    repo: string,
    permissions: GithubPermissions,
    jwt: string,
    id: number,
  ): ResultAsync<InstallationToken, GithubAppError> {
    const name = repo.split('/')[1];
    return github(`/app/installations/${id}/access_tokens`, {
      method: 'POST',
      auth: `Bearer ${jwt}`,
      body: JSON.stringify({ repositories: [name], permissions }),
    }).andThen((res): ResultAsync<InstallationToken, GithubAppError> => {
      if (!res.ok) {
        return errAsync(githubAppError('github-error', `GitHub refused the token (${res.status})`));
      }
      return ResultAsync.fromPromise(
        res.json() as Promise<{ token?: string; expires_at?: string }>,
        () => githubAppError('github-error', 'unreadable token response'),
      ).andThen((body) =>
        body.token && body.expires_at
          ? okAsync({ token: body.token, expiresAt: body.expires_at, repo })
          : errAsync(githubAppError('github-error', 'token response without token')),
      );
    });
  }

  return {
    issue({ app, repo, permissions }) {
      const normalized = repo.toLowerCase();
      const cacheKey = `${app.appId}:${normalized}:${permissionsKey(permissions)}`;
      const cached = tokens.get(cacheKey);
      if (
        cached &&
        Date.parse(cached.expiresAt) - now().getTime() > GITHUB_APP_TOKEN_REUSE_MARGIN_MS
      ) {
        return okAsync(cached);
      }
      const jwt = signAppJwt(app.appId, app.privateKey, now());
      if (jwt.isErr()) return errAsync(githubAppError('not-configured', jwt.error));
      return installationId(app.appId, normalized, jwt.value)
        .andThen((id) => mint(normalized, permissions, jwt.value, id))
        .map((token) => {
          tokens.set(cacheKey, token);
          return token;
        });
    },
  };
}
