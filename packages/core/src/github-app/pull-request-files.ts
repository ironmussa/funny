/**
 * The files a pull request changes, with their patches (change
 * factory-agent-roles): what the server reads to check a change without an
 * agent (weakened tests, risk class). Read with a repository-scoped token
 * through `RepoGithub`, like the rest of this module.
 */

import { okAsync, type ResultAsync } from 'neverthrow';

import type { GithubCallError, RepoGithub } from './repo-github.js';

export type PullRequestFileStatus =
  | 'added'
  | 'removed'
  | 'modified'
  | 'renamed'
  | 'copied'
  | 'changed'
  | 'unchanged';

export interface PullRequestFile {
  /** The file's path after the change. */
  path: string;
  /** Its path before, when it was renamed. */
  previousPath?: string;
  status: PullRequestFileStatus;
  additions: number;
  deletions: number;
  /** The unified diff of the file; absent when GitHub gives none (binary, or too large). */
  patch?: string;
}

export interface PullRequestFiles {
  files: PullRequestFile[];
  /** More files exist than were read: the list is not the whole change. */
  truncated: boolean;
}

interface RestFile {
  filename: string;
  previous_filename?: string;
  status: PullRequestFileStatus;
  additions: number;
  deletions: number;
  patch?: string;
}

const PER_PAGE = 100;

/** GitHub lists at most 3000 files of a pull request; reading stops well before. */
export const MAX_PULL_REQUEST_FILES = 1000;

function toFile(file: RestFile): PullRequestFile {
  const mapped: PullRequestFile = {
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  };
  if (file.previous_filename) mapped.previousPath = file.previous_filename;
  if (file.patch !== undefined) mapped.patch = file.patch;
  return mapped;
}

/**
 * The files of pull request `number`, page by page, up to
 * `MAX_PULL_REQUEST_FILES`; `truncated` says the pull request has more.
 */
export function listPullRequestFiles(
  github: RepoGithub,
  repo: string,
  number: number,
): ResultAsync<PullRequestFiles, GithubCallError> {
  const page = (
    index: number,
    read: PullRequestFile[],
  ): ResultAsync<PullRequestFiles, GithubCallError> =>
    github
      .json<RestFile[]>(
        repo,
        'GET',
        `/repos/${repo}/pulls/${number}/files?per_page=${PER_PAGE}&page=${index}`,
      )
      .andThen((answer) => {
        const files = [...read, ...answer.map(toFile)];
        const more = answer.length === PER_PAGE;
        if (!more) return okAsync({ files, truncated: false });
        if (files.length >= MAX_PULL_REQUEST_FILES) return okAsync({ files, truncated: true });
        return page(index + 1, files);
      });
  return page(1, []);
}
