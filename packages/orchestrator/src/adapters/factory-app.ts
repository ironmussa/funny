/**
 * The Factory App's installation tokens: one per repository, with the App's
 * write set, from the shared issuer in `@funny/core/github-app`. The factory
 * has no personal access token; the App being installed only on the watched
 * repositories is the boundary (ADR 0001).
 */

import {
  createInstallationTokenIssuer,
  type GithubAppCredentials,
  type GithubAppError,
  type GithubPermissions,
  type InstallationToken,
} from '@funny/core/github-app';
import type { ResultAsync } from 'neverthrow';

import type { Clock } from '../ports/clock.js';

/** What a factory run may do on its repository. */
const FACTORY_PERMISSIONS: GithubPermissions = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  workflows: 'write',
  actions: 'read',
  checks: 'read',
  statuses: 'read',
  metadata: 'read',
};

export interface FactoryAppTokens {
  /** A token for `repo` (`owner/name`), reused while it is fresh. */
  forRepo(repo: string): ResultAsync<InstallationToken, GithubAppError>;
}

export function createFactoryAppTokens(deps: {
  app: GithubAppCredentials;
  fetch?: typeof fetch;
  api?: string;
  clock: Clock;
}): FactoryAppTokens {
  const issuer = createInstallationTokenIssuer({
    fetch: deps.fetch,
    api: deps.api,
    userAgent: 'funny-issue-factory',
    now: () => deps.clock.now(),
  });
  return {
    forRepo: (repo) => issuer.issue({ app: deps.app, repo, permissions: FACTORY_PERMISSIONS }),
  };
}
