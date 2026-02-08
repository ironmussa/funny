/**
 * Diff service - now using async git operations from git-v2
 *
 * This file re-exports functions from git-v2 for backward compatibility.
 * All functions are now async and use safe command execution.
 */

export {
  getDiff,
  stageFiles,
  unstageFiles,
  revertFiles,
  commit,
  push,
  createPR,
} from '../utils/git-v2.js';
