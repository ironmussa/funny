// ─── GitHub ──────────────────────────────────────────────

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  clone_url: string;
  language: string | null;
  updated_at: string;
  stargazers_count: number;
  default_branch: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  body: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  user: {
    login: string;
    avatar_url: string;
  } | null;
  labels: Array<{
    name: string;
    color: string;
  }>;
  comments: number;
  pull_request?: unknown;
}

export interface EnrichedGitHubIssue extends GitHubIssue {
  linkedBranch: string | null;
  linkedPR: { number: number; url: string; state: string } | null;
  suggestedBranchName: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  user: {
    login: string;
    avatar_url: string;
  } | null;
  created_at: string;
  updated_at: string;
  head: { ref: string; label: string };
  base: { ref: string; label: string };
  draft: boolean;
  labels: Array<{
    name: string;
    color: string;
  }>;
  merged_at: string | null;
}

// ─── PR Detail (rich data for PR Summary Card) ───────────

export type CICheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'stale'
  | null;

export interface CICheck {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: CICheckConclusion;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  app_name: string | null;
}

export type MergeableState = 'mergeable' | 'conflicting' | 'unknown';
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

export interface PRDetail {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  mergeable_state: MergeableState;
  html_url: string;
  additions: number;
  deletions: number;
  changed_files: number;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string; avatar_url: string } | null;
  review_decision: ReviewDecision;
  checks: CICheck[];
  checks_passed: number;
  checks_failed: number;
  checks_pending: number;
  created_at: string;
  updated_at: string;
}

// ─── PR Review Threads (inline comments) ─────────────────

export interface PRThreadComment {
  id: number;
  author: string;
  author_avatar_url: string;
  body: string;
  created_at: string;
  updated_at: string;
  author_association: string;
}

export interface PRReviewThread {
  id: number;
  /** GraphQL node id for the review thread (used for resolve/unresolve). */
  node_id?: string | null;
  path: string;
  line: number | null;
  original_line: number | null;
  side: 'LEFT' | 'RIGHT';
  start_line: number | null;
  is_resolved: boolean;
  is_outdated: boolean;
  comments: PRThreadComment[];
}

// ─── PR Conversation (issue-level comments + reviews) ─────

export interface PRReactionSummary {
  total: number;
  plus1: number;
  minus1: number;
  laugh: number;
  hooray: number;
  confused: number;
  heart: number;
  rocket: number;
  eyes: number;
}

export interface PRIssueComment {
  id: number;
  author: string;
  author_avatar_url: string;
  author_association: string;
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  reactions: PRReactionSummary;
}

export interface PRReview {
  id: number;
  author: string;
  author_avatar_url: string;
  body: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at: string;
  html_url: string;
}

export interface PRConversation {
  comments: PRIssueComment[];
  reviews: PRReview[];
}

export type PRCommentKind = 'issue' | 'review';

export type PRReactionContent =
  | '+1'
  | '-1'
  | 'laugh'
  | 'confused'
  | 'heart'
  | 'hooray'
  | 'rocket'
  | 'eyes';

// ─── PR Files (changed files in a PR) ───────────────────

export interface PRFile {
  sha: string;
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

// ─── PR Commits ─────────────────────────────────────────

export interface PRCommit {
  sha: string;
  message: string;
  author: {
    login: string;
    avatar_url: string;
  } | null;
  date: string;
}

export interface CloneRepoRequest {
  cloneUrl: string;
  destinationPath: string;
  name?: string;
}
