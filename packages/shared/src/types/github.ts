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
  body?: string | null;
  state: 'open' | 'closed';
  html_url: string;
  user: {
    login: string;
    avatar_url: string;
  } | null;
  created_at: string;
  updated_at: string;
  head: { ref: string; label: string; sha?: string };
  base: { ref: string; label: string };
  draft: boolean;
  labels: Array<{
    name: string;
    color: string;
  }>;
  /** Users assigned to the PR. Populated by both the list and search endpoints. */
  assignees?: Array<{
    login: string;
    avatar_url: string;
  }>;
  /**
   * Users whose review was requested. Only the `/pulls` list endpoint carries
   * these — the GitHub Search API omits them, so search-mode results leave this
   * undefined even though `review-requested:` filtering still works server-side.
   */
  requested_reviewers?: Array<{
    login: string;
    avatar_url: string;
  }>;
  /** Number of commits currently in the pull request. Present when the list endpoint can resolve it. */
  commits?: number;
  merged_at: string | null;
  /** Last commit currently at the PR head. Present when the list endpoint can resolve head.sha. */
  last_commit?: PRCommit | null;
}

/** A user reference used to populate the PR filter dropdowns. */
export interface GitHubUserRef {
  login: string;
  avatar_url: string;
}

/**
 * Options used to populate the PR filter UI: the repo's labels and its
 * assignable users (collaborators/org members) — the latter feeds the author,
 * assignee, and reviewer pickers.
 */
export interface PRFilterOptions {
  labels: Array<{ name: string; color: string }>;
  users: GitHubUserRef[];
}

/**
 * Unified PR sort key understood by both the list and search endpoints. The
 * backend translates each key into the per-endpoint GitHub params
 * (`sort`+`direction` for `/pulls`, `sort`+`order` for `/search/issues`).
 */
export type PRSortKey =
  | 'newest'
  | 'oldest'
  | 'recently-updated'
  | 'least-recently-updated'
  | 'most-commented';

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
  /** Actions only: the run could not start (e.g. an invalid workflow file). */
  | 'startup_failure'
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
  commits: number;
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
  /** Last commit currently at the PR head. Present when the detail endpoint can resolve head.sha. */
  last_commit?: PRCommit | null;
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
  /** Raw git author name, used when the commit is not linked to a GitHub user. */
  author_name?: string | null;
  date: string;
}

export interface CloneRepoRequest {
  cloneUrl: string;
  destinationPath: string;
  name?: string;
}

// ── GitHub Actions (the review pane's Actions tab) ──────────

/** A run, job or step lifecycle: GitHub's `waiting` / `requested` / `pending` count as `queued`. */
export type ActionStatus = 'queued' | 'in_progress' | 'completed';

/** One workflow run, as listed by `GET /repos/{owner}/{repo}/actions/runs`. */
export interface ActionRun {
  id: number;
  /** Workflow name (`CI`, `E2E`, …). */
  name: string;
  /** What GitHub shows as the run's title: the commit message or PR title. */
  display_title: string;
  run_number: number;
  run_attempt: number;
  /** Trigger: `push`, `pull_request`, `schedule`, `workflow_dispatch`, … */
  event: string;
  status: ActionStatus;
  conclusion: CICheckConclusion;
  head_branch: string | null;
  head_sha: string;
  html_url: string;
  actor: GitHubUserRef | null;
  created_at: string;
  run_started_at: string | null;
  updated_at: string;
}

export interface ActionRunsPage {
  runs: ActionRun[];
  total_count: number;
  hasMore: boolean;
}

export interface ActionStep {
  number: number;
  name: string;
  status: ActionStatus;
  conclusion: CICheckConclusion;
  started_at: string | null;
  completed_at: string | null;
}

export interface ActionJob {
  id: number;
  name: string;
  status: ActionStatus;
  conclusion: CICheckConclusion;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps: ActionStep[];
}

/**
 * The end of a job's log, up to its last `##[error]` line: where a failed job
 * says why. Timestamps are stripped; error lines are colored with ANSI red.
 */
export interface ActionJobLog {
  lines: string[];
  /** Earlier lines were cut. */
  truncated: boolean;
}
