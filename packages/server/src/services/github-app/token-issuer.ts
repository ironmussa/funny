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
 * part of the result. Minting itself (the App JWT, the installation, the
 * repository-scoped token and its reuse) is `@funny/core/github-app`; the cap
 * stays here, on the server.
 */

import { createHash } from 'node:crypto';

import {
  createGithubRest,
  createInstallationTokenIssuer,
  type GithubAppErrorKind,
  type GithubPermissions,
} from '@funny/core/github-app';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import type { GithubAppConfig } from './app-config.js';

export type AccessLevel = 'write' | 'read';

/** What a sandbox token may do, per the owner's level. A subset of the App's permissions. */
export const SANDBOX_PERMISSIONS: Record<AccessLevel, GithubPermissions> = {
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

export type IssueErrorKind = GithubAppErrorKind | 'no-access';
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

/** How long the owner's level on a repository is remembered. */
const CACHE_MS = 10 * 60 * 1000;
const USER_AGENT = 'funny-sandbox-github-app';

const fail = (kind: IssueErrorKind, message: string): IssueError => ({ kind, message });
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function levelOf(permissions: Record<string, boolean> | undefined): AccessLevel | null {
  if (!permissions) return null;
  if (permissions.admin || permissions.maintain || permissions.push) return 'write';
  if (permissions.triage || permissions.pull) return 'read';
  return null;
}

export function createGithubAppTokenIssuer(deps: TokenIssuerDeps) {
  const rest = { fetch: deps.fetch, api: deps.api, userAgent: USER_AGENT };
  const github = createGithubRest(rest);
  const now = deps.now ?? (() => new Date());
  const installationTokens = createInstallationTokenIssuer({ ...rest, now });
  const ownerLevels = new Map<string, { level: AccessLevel | null; until: number }>();

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
            return installationTokens
              .issue({ app, repo: normalized, permissions: SANDBOX_PERMISSIONS[level] })
              .map((token): RepoToken => ({ ...token, level }));
          }),
        );
    },
  };
}
