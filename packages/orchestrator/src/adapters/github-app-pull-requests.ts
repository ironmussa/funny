/**
 * The CI of a factory run's pull request over GitHub's API, with the Factory
 * App's token. The logic lives in `@funny/core/github-app` (`createPullRequestCi`),
 * shared with the server's `wait_ci` / `merge` workflow nodes; this binds it to
 * the factory's own App tokens.
 */

import { createPullRequestCi } from '@funny/core/github-app';

import type { PullRequestCi } from '../ports/pull-request-ci.js';
import type { FactoryAppTokens } from './factory-app.js';
import { createFactoryGithub } from './factory-github.js';

export function createGithubAppPullRequests(deps: {
  tokens: FactoryAppTokens;
  fetch?: typeof fetch;
  api?: string;
}): PullRequestCi {
  return createPullRequestCi(createFactoryGithub(deps));
}
