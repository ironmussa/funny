export {
  execute,
  executeSync,
  executeWithLogging,
  executeResult,
  executeShell,
  gitRead,
  gitWrite,
  SHELL,
  ProcessExecutionError,
  type ProcessResult,
  type ProcessOptions,
} from './process.js';

export {
  validatePath,
  validatePathSync,
  pathExists,
  sanitizePath,
  validateProjectPathLexical,
  validateProjectRootContainment,
  validateProjectRootPath,
} from './path-validation.js';

export { getNativeGit } from './native.js';

export { toDomainError } from './errors.js';

export {
  git,
  gitOptional,
  gitSync,
  gitSafeSync,
  isGitRepo,
  isGitRepoSync,
  isGitRepoRoot,
  isGitRepoRootSync,
  gitRemote,
  type GitIdentityOptions,
} from './base.js';

export {
  getCurrentBranch,
  listBranches,
  listBranchesDetailed,
  fetchRemote,
  getDefaultBranch,
  getRemoteUrl,
  extractRepoName,
  initRepo,
  type BranchInfo,
} from './branch.js';

export {
  stageFiles,
  unstageFiles,
  stagePatch,
  unstagePatch,
  revertFiles,
  addToGitignore,
  resolveFileConflict,
} from './stage.js';

export { commit, runHookCommand } from './commit.js';

export { push, pushBranch, pull, createPR, mergeBranch, cloneRepo, setOrigin } from './remote.js';
export type { PullStrategy } from './remote.js';

export {
  getDiff,
  getDiffSummary,
  getIgnoredFileStats,
  getSingleFileDiff,
  getFullContextFileDiff,
} from './diff.js';

export { getBlame } from './blame.js';
export type { BlameHunk, BlameResult } from './blame.js';

export {
  getStatusSummary,
  getCommittedBranchSummary,
  invalidateStatusCache,
  deriveGitSyncState,
  type GitStatusSummary,
} from './status.js';

export {
  getLog,
  getGraphLog,
  getCommitBody,
  getCommitFiles,
  getCommitFileDiff,
  getUnpushedHashes,
  type GitLogEntry,
  type GitGraphLogEntry,
  type GraphRef,
  type GraphRefKind,
  type CommitFileEntry,
} from './log.js';

export {
  stash,
  stashFiles,
  stashPop,
  stashDrop,
  stashList,
  stashShow,
  stashFileDiff,
  resetSoft,
  type StashEntry,
} from './stash.js';

export {
  createWorktree,
  listWorktrees,
  removeWorktree,
  removeBranch,
  getWorktreeBase,
  getWorktreeBasePath,
  getLastGitActivity,
  previewWorktree,
  pruneOrphanWorktrees,
  checkWorktreePathInProject,
  WORKTREE_DIR_NAME,
  type WorktreeInfo,
  type WorktreePreview,
} from './worktree.js';

export { getWeaveStatus, ensureWeaveConfigured } from './weave.js';

export {
  fetchPRReviews,
  checkPRApprovalStatus,
  mergePR,
  getPRInfo,
  getPRDiff,
  postPRReview,
  getPRForBranch,
  type PRReview,
  type PRReviewComment,
  type ReviewDecision,
  type PRReviewData,
  type PRInfo,
  type ReviewEvent,
  type BranchPRInfo,
  listGitHubOrgs,
  publishRepo,
  type PublishRepoOptions,
} from './github.js';
