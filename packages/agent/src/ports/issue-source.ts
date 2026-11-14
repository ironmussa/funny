/**
 * The issues the factory works from, as seen through its Factory App.
 *
 * Only the configured login's text is trusted: `readTrusted` returns the issue
 * body and that login's comments, never anyone else's.
 */

import type { ResultAsync } from 'neverthrow';

export interface ReadyIssue {
  number: number;
  title: string;
  /** Login of the issue's author. */
  author: string;
  createdAt: string;
}

export interface TrustedIssue {
  number: number;
  title: string;
  /** The body and the configured login's comments. */
  body: string;
}

export interface IssueSourceError {
  message: string;
}

export interface IssueSource {
  /** Open issues (not pull requests) carrying `label`, oldest first. */
  listReady(repo: string, label: string): ResultAsync<ReadyIssue[], IssueSourceError>;
  /** The issue's text written by `login`. */
  readTrusted(
    repo: string,
    issue: number,
    login: string,
  ): ResultAsync<TrustedIssue, IssueSourceError>;
  /** Assign `login`, swap the ready label for the in-progress one, and comment. */
  claim(
    repo: string,
    issue: number,
    claim: { login: string; readyLabel: string; inProgressLabel: string; comment: string },
  ): ResultAsync<void, IssueSourceError>;
  defaultBranch(repo: string): ResultAsync<string, IssueSourceError>;
}
