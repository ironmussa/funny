/**
 * Shared DB-agnostic repositories.
 *
 * Each repository is created via a factory function that accepts
 * database dependencies (db, schema, dbAll/dbGet/dbRun) via injection.
 */

export { createMessageRepository, type MessageRepositoryDeps } from './message-repository.js';
export { createToolCallRepository, type ToolCallRepositoryDeps } from './tool-call-repository.js';
export { createThreadRepository, type ThreadRepositoryDeps } from './thread-repository.js';
export { createCommentRepository, type CommentRepositoryDeps } from './comment-repository.js';
export {
  createThreadShareRepository,
  type ThreadShareRepositoryDeps,
} from './thread-share-repository.js';
export {
  createGrantRepository,
  type GrantRepositoryDeps,
  type GrantRepository,
  type ResourceGrant,
} from './grant-repository.js';
export { createStageHistoryRepository, type StageHistoryDeps } from './stage-history.js';
export { createDesignRepository, type DesignRepositoryDeps } from './design-repository.js';
export {
  createSchedulerRunRepository,
  type SchedulerRunRepositoryDeps,
  type SchedulerRunRepository,
  type SchedulerRunRow,
  type ClaimArgs,
} from './scheduler-run-repository.js';
export {
  createWatcherRepository,
  type WatcherRepositoryDeps,
  type WatcherRepository,
  type WatcherRow,
  type WatcherPatch,
} from './watcher-repository.js';
export {
  createJobRepository,
  type JobRepositoryDeps,
  type JobRepository,
  type JobRow,
  type JobPatch,
} from './job-repository.js';
