export {
  execute, executeSync, executeWithLogging, executeResult,
  ProcessExecutionError,
  type ProcessResult, type ProcessOptions,
} from './process.js';

export {
  validatePath, validatePathSync, pathExists, sanitizePath,
} from './path-validation.js';

export {
  git, gitSync, gitSafeSync, isGitRepo, isGitRepoSync,
  getCurrentBranch, listBranches, getDefaultBranch, getRemoteUrl,
  extractRepoName, initRepo, stageFiles, unstageFiles, revertFiles,
  addToGitignore,
  commit, push, pull, createPR, mergeBranch, getDiff, getDiffSummary, getSingleFileDiff,
  getStatusSummary, deriveGitSyncState,
  getLog, stash, stashPop, stashList, resetSoft,
  type GitIdentityOptions, type GitStatusSummary,
  type GitLogEntry, type StashEntry,
} from './git.js';

export {
  createWorktree, listWorktrees, removeWorktree, removeBranch,
  type WorktreeInfo,
} from './worktree.js';

export {
  fetchPRReviews, checkPRApprovalStatus, mergePR,
  type PRReview, type PRReviewComment, type ReviewDecision, type PRReviewData,
} from './github.js';
