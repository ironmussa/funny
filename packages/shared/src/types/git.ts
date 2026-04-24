// ─── Git Diffs ───────────────────────────────────────────

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'conflicted';

/**
 * Kind of entry tracked by git.
 * - 'file' (default): regular file.
 * - 'submodule': gitlink (mode 160000) or nested git repo — the entry represents a whole repository, not a file.
 */
export type FileDiffKind = 'file' | 'submodule';

/**
 * Aggregate changes inside a nested git repository (submodule / gitlink).
 * Populated for entries with `kind: 'submodule'` so the UI can show what
 * changed *inside* the nested repo without loading its full file list.
 */
export interface NestedDirtyStats {
  /** Count of dirty files inside the nested repo (modified + staged + untracked). */
  dirtyFileCount: number;
  linesAdded: number;
  linesDeleted: number;
  /** Whether the submodule's HEAD commit moved (gitlink pointer changed). */
  pointerMoved?: boolean;
}

export interface FileDiff {
  path: string;
  status: FileStatus;
  diff: string;
  staged: boolean;
  kind?: FileDiffKind;
  nestedDirty?: NestedDirtyStats;
}

/** Lightweight file metadata without diff content (for summary endpoint). */
export interface FileDiffSummary {
  path: string;
  status: FileStatus;
  staged: boolean;
  additions?: number;
  deletions?: number;
  kind?: FileDiffKind;
  nestedDirty?: NestedDirtyStats;
}

export interface DiffSummaryResponse {
  files: FileDiffSummary[];
  total: number;
  truncated: boolean;
}

// ─── Git Sync Status ────────────────────────────────────

export type GitSyncState = 'dirty' | 'unpushed' | 'pushed' | 'merged' | 'clean';

export interface GitStatusInfo {
  threadId: string;
  branchKey: string;
  state: GitSyncState;
  dirtyFileCount: number;
  unpushedCommitCount: number;
  unpulledCommitCount: number;
  hasRemoteBranch: boolean;
  isMergedIntoBase: boolean;
  linesAdded: number;
  linesDeleted: number;
  /** PR number if the branch has an open/merged PR on GitHub */
  prNumber?: number;
  /** PR URL on GitHub */
  prUrl?: string;
  /** PR state: OPEN, MERGED, or CLOSED */
  prState?: 'OPEN' | 'MERGED' | 'CLOSED';
}

export interface WSGitStatusData {
  statuses: GitStatusInfo[];
}

// ─── Merge Agent ─────────────────────────────────────────

export interface MergeProgress {
  branch: string;
  status: 'merging' | 'conflict' | 'resolved' | 'done' | 'failed';
  message?: string;
}

// ─── Git Workflow (server-side orchestration) ────────────

export type GitWorkflowAction =
  | 'commit'
  | 'amend'
  | 'commit-push'
  | 'commit-pr'
  | 'commit-merge'
  | 'push'
  | 'merge'
  | 'create-pr';

export interface GitWorkflowRequest {
  action: GitWorkflowAction;
  message?: string;
  filesToStage?: string[];
  filesToUnstage?: string[];
  amend?: boolean;
  noVerify?: boolean;
  prTitle?: string;
  prBody?: string;
  targetBranch?: string;
  cleanup?: boolean;
}

export interface GitWorkflowProgressStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  url?: string;
  subItems?: {
    label: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    error?: string;
  }[];
}

export interface WSGitWorkflowProgressData {
  workflowId: string;
  status: 'started' | 'step_update' | 'completed' | 'failed';
  title: string;
  action: GitWorkflowAction;
  steps: GitWorkflowProgressStep[];
}
