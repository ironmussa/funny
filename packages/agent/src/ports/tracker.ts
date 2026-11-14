/**
 * Tracker — pluggable interface for issue tracking systems.
 *
 * Implementations pull issues from GitHub, Linear, etc.
 * The orchestrator uses trackers to read the backlog and
 * update issue state as sessions progress.
 */

// ── Types ───────────────────────────────────────────────────────

export interface IssueLabel {
  name: string;
  color: string;
}

export interface IssueUser {
  login: string;
  avatarUrl?: string;
}

export interface IssueComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  body: string | null;
  url: string;
  labels: IssueLabel[];
  assignee: IssueUser | null;
  commentsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface IssueDetail extends Issue {
  comments: IssueComment[];
  /** Full markdown body including any linked PRs, related issues, etc. */
  fullContext: string;
}

export interface IssueFilter {
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  excludeLabels?: string[];
  assignee?: string;
  milestone?: string;
  sort?: 'created' | 'updated' | 'comments';
  direction?: 'asc' | 'desc';
  limit?: number;
}

// ── Tracker Interface ───────────────────────────────────────────

export interface Tracker {
  readonly name: string;

  /** Fetch issues matching the filter */
  fetchIssues(filter: IssueFilter): Promise<Issue[]>;

  /** Fetch full issue detail including comments */
  fetchIssueDetail(issueNumber: number): Promise<IssueDetail>;

  /** Add a comment to an issue */
  addComment(issueNumber: number, body: string): Promise<void>;

  /** Update labels on an issue */
  updateLabels(issueNumber: number, add: string[], remove?: string[]): Promise<void>;

  /** Assign an issue */
  assignIssue(issueNumber: number, assignee: string): Promise<void>;

  /** Close an issue with an optional comment */
  closeIssue(issueNumber: number, comment?: string): Promise<void>;
}
