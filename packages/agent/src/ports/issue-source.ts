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
  /** Logins it is assigned to. */
  assignees: string[];
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
  /** GitHub's HTTP status, when it answered. */
  status?: number;
  /** `not-installed` when the Factory App is not installed on the repository. */
  kind?: string;
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
  /**
   * Assign `login`, swap the ready label for the in-progress one, and comment
   * (no comment when `comment` is absent: a retry of a claimed issue). Safe to
   * repeat.
   */
  claim(
    repo: string,
    issue: number,
    claim: { login: string; readyLabel: string; inProgressLabel: string; comment?: string },
  ): ResultAsync<void, IssueSourceError>;
  /**
   * Give the issue back after a failed factory run: reset the labels (neither
   * ready nor in progress, so it is not admitted again until someone says so)
   * and say why.
   */
  handBack(
    repo: string,
    issue: number,
    handBack: { readyLabel: string; inProgressLabel: string; comment: string },
  ): ResultAsync<void, IssueSourceError>;
  defaultBranch(repo: string): ResultAsync<string, IssueSourceError>;
  /** Numbers of the open issues blocking `issue`, by GitHub's native issue dependencies. */
  openBlockers(repo: string, issue: number): ResultAsync<number[], IssueSourceError>;
  /** Create the labels the repository lacks. */
  ensureLabels(repo: string, labels: string[]): ResultAsync<void, IssueSourceError>;
}
