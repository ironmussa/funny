/**
 * GitHub's REST and GraphQL APIs as the factory calls them: with the Factory
 * App's token for the repository at hand (`createRepoGithub` in
 * `@funny/core/github-app`). Shared by the issue source and the pull requests
 * adapter.
 */

import { createRepoGithub, type RepoGithub } from '@funny/core/github-app';

import type { FactoryAppTokens } from './factory-app.js';

export function createFactoryGithub(deps: {
  tokens: FactoryAppTokens;
  fetch?: typeof fetch;
  api?: string;
}): RepoGithub {
  return createRepoGithub({
    tokenFor: (repo) => deps.tokens.forRepo(repo).map((token) => token.token),
    fetch: deps.fetch,
    api: deps.api,
    userAgent: 'funny-issue-factory',
  });
}
