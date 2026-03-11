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

export { validatePath, validatePathSync, pathExists, sanitizePath } from './path-validation.js';

export { getNativeGit } from './native.js';

export {
  git,
  gitSync,
  gitSafeSync,
  isGitRepo,
  isGitRepoSync,
  getCurrentBranch,
  listBranches,
  getDefaultBranch,
  getRemoteUrl,
  extractRepoName,
  initRepo,
  stageFiles,
  unstageFiles,
  revertFiles,
  addToGitignore,
  commit,
  runHookCommand,
  push,
  pull,
  createPR,
  mergeBranch,
  getDiff,
  getDiffSummary,
  getSingleFileDiff,
  getStatusSummary,
  invalidateStatusCache,
  deriveGitSyncState,
  getLog,
  stash,
  stashPop,
  stashList,
  resetSoft,
  cloneRepo,
  type GitIdentityOptions,
  type GitStatusSummary,
  type GitLogEntry,
  type StashEntry,
} from './git.js';

export {
  createWorktree,
  listWorktrees,
  removeWorktree,
  removeBranch,
  getWorktreeBase,
  WORKTREE_DIR_NAME,
  type WorktreeInfo,
} from './worktree.js';

export { getWeaveStatus, ensureWeaveConfigured } from './weave.js';

export {
  fetchPRReviews,
  checkPRApprovalStatus,
  mergePR,
  getPRInfo,
  getPRDiff,
  postPRReview,
  type PRReview,
  type PRReviewComment,
  type ReviewDecision,
  type PRReviewData,
  type PRInfo,
  type ReviewEvent,
} from './github.js';
