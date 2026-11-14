/**
 * The issue source over GitHub's REST API, authenticated with the Factory
 * App's token for each repository. No `gh` login and no personal token is
 * involved.
 */

import { errAsync, okAsync, type ResultAsync } from 'neverthrow';

import type { IssueSource, IssueSourceError, ReadyIssue } from '../ports/issue-source.js';
import type { FactoryAppTokens } from './factory-app.js';
import { createFactoryGithub } from './factory-github.js';

interface RestIssue {
  number: number;
  title: string;
  body: string | null;
  state?: string;
  user: { login: string } | null;
  assignees?: Array<{ login: string }>;
  created_at: string;
  pull_request?: unknown;
}

interface RestComment {
  user: { login: string } | null;
  body: string;
}

const PAGE_SIZE = 100;
/** Lists longer than this many pages are cut (10 000 items). */
const MAX_PAGES = 100;

/** Color of the labels the factory creates. */
const LABEL_COLOR = '5319e7';

export function createGithubAppIssueSource(deps: {
  tokens: FactoryAppTokens;
  fetch?: typeof fetch;
  api?: string;
}): IssueSource {
  const github = createFactoryGithub(deps);
  const call = github.json;
  /** Every page of a list (100 per page, at most `MAX_PAGES`). */
  const allPages = <T>(
    repo: string,
    path: string,
    page = 1,
    acc: T[] = [],
  ): ResultAsync<T[], IssueSourceError> =>
    call<T[]>(
      repo,
      'GET',
      `${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`,
    ).andThen((items) =>
      items.length < PAGE_SIZE || page >= MAX_PAGES
        ? okAsync([...acc, ...items])
        : allPages(repo, path, page + 1, [...acc, ...items]),
    );
  /** Removing a label the issue no longer has is not an error (a retry, a person removed it). */
  const removeLabel = (repo: string, issue: string, label: string) =>
    call(repo, 'DELETE', `${issue}/labels/${encodeURIComponent(label)}`).orElse((e) =>
      e.status === 404 ? okAsync(undefined) : errAsync(e),
    );

  return {
    listReady(repo, label) {
      const query = new URLSearchParams({
        state: 'open',
        labels: label,
        sort: 'created',
        direction: 'asc',
      });
      return allPages<RestIssue>(repo, `/repos/${repo}/issues?${query}`).map((issues) =>
        issues
          .filter((issue) => !issue.pull_request)
          .map((issue): ReadyIssue => ({
            number: issue.number,
            title: issue.title,
            author: issue.user?.login ?? '',
            assignees: (issue.assignees ?? []).map((a) => a.login),
            createdAt: issue.created_at,
          })),
      );
    },

    readTrusted(repo, number, login) {
      const own = (user: { login: string } | null) =>
        user?.login.toLowerCase() === login.toLowerCase();
      return call<RestIssue>(repo, 'GET', `/repos/${repo}/issues/${number}`).andThen((issue) =>
        allPages<RestComment>(repo, `/repos/${repo}/issues/${number}/comments`).map((comments) => ({
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
        .andThen(() => removeLabel(repo, issue, claim.readyLabel))
        .andThen(() =>
          claim.comment
            ? call(repo, 'POST', `${issue}/comments`, { body: claim.comment })
            : okAsync(undefined),
        )
        .map(() => undefined);
    },

    handBack(repo, number, handBack) {
      const issue = `/repos/${repo}/issues/${number}`;
      return removeLabel(repo, issue, handBack.inProgressLabel)
        .andThen(() => removeLabel(repo, issue, handBack.readyLabel))
        .andThen(() => call(repo, 'POST', `${issue}/comments`, { body: handBack.comment }))
        .map(() => undefined);
    },

    openBlockers(repo, number) {
      // A blocker of unknown state blocks: in doubt, the issue waits.
      return allPages<RestIssue>(
        repo,
        `/repos/${repo}/issues/${number}/dependencies/blocked_by`,
      ).map((blockers) => blockers.filter((b) => b.state !== 'closed').map((b) => b.number));
    },

    ensureLabels(repo, labels) {
      const ensure = (name: string) =>
        call(repo, 'GET', `/repos/${repo}/labels/${encodeURIComponent(name)}`)
          .map(() => undefined)
          .orElse((e) =>
            e.status === 404
              ? call(repo, 'POST', `/repos/${repo}/labels`, {
                  name,
                  color: LABEL_COLOR,
                  description: 'Used by the issue factory',
                }).map(() => undefined)
              : errAsync(e),
          );
      return labels.reduce(
        (done, name) => done.andThen(() => ensure(name)),
        okAsync<void, IssueSourceError>(undefined),
      );
    },

    defaultBranch(repo) {
      return call<{ default_branch: string }>(repo, 'GET', `/repos/${repo}`).map(
        (r) => r.default_branch,
      );
    },
  };
}
