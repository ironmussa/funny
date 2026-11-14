/**
 * The issue source over GitHub's REST API, authenticated with the Factory
 * App's token for each repository. No `gh` login and no personal token is
 * involved.
 */

import type { IssueSource, ReadyIssue } from '../ports/issue-source.js';
import type { FactoryAppTokens } from './factory-app.js';
import { createFactoryGithub } from './factory-github.js';

interface RestIssue {
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
  pull_request?: unknown;
}

interface RestComment {
  user: { login: string } | null;
  body: string;
}

export function createGithubAppIssueSource(deps: {
  tokens: FactoryAppTokens;
  fetch?: typeof fetch;
  api?: string;
}): IssueSource {
  const github = createFactoryGithub(deps);
  const call = github.json;

  return {
    listReady(repo, label) {
      const query = new URLSearchParams({
        state: 'open',
        labels: label,
        sort: 'created',
        direction: 'asc',
        per_page: '100',
      });
      return call<RestIssue[]>(repo, 'GET', `/repos/${repo}/issues?${query}`).map((issues) =>
        issues
          .filter((issue) => !issue.pull_request)
          .map((issue): ReadyIssue => ({
            number: issue.number,
            title: issue.title,
            author: issue.user?.login ?? '',
            createdAt: issue.created_at,
          })),
      );
    },

    readTrusted(repo, number, login) {
      const own = (user: { login: string } | null) =>
        user?.login.toLowerCase() === login.toLowerCase();
      return call<RestIssue>(repo, 'GET', `/repos/${repo}/issues/${number}`).andThen((issue) =>
        call<RestComment[]>(
          repo,
          'GET',
          `/repos/${repo}/issues/${number}/comments?per_page=100`,
        ).map((comments) => ({
          number,
          title: issue.title,
          body: [
            own(issue.user) ? (issue.body ?? '') : '',
            ...comments
              .filter((c) => own(c.user))
              .map((c) => `---\nComment by @${login}:\n\n${c.body}`),
          ]
            .filter(Boolean)
            .join('\n\n'),
        })),
      );
    },

    claim(repo, number, claim) {
      const issue = `/repos/${repo}/issues/${number}`;
      return call(repo, 'POST', `${issue}/assignees`, { assignees: [claim.login] })
        .andThen(() => call(repo, 'POST', `${issue}/labels`, { labels: [claim.inProgressLabel] }))
        .andThen(() =>
          call(repo, 'DELETE', `${issue}/labels/${encodeURIComponent(claim.readyLabel)}`),
        )
        .andThen(() => call(repo, 'POST', `${issue}/comments`, { body: claim.comment }))
        .map(() => undefined);
    },

    defaultBranch(repo) {
      return call<{ default_branch: string }>(repo, 'GET', `/repos/${repo}`).map(
        (r) => r.default_branch,
      );
    },
  };
}
