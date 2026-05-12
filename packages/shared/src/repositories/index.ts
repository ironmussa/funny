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
export { createStageHistoryRepository, type StageHistoryDeps } from './stage-history.js';
export { createDesignRepository, type DesignRepositoryDeps } from './design-repository.js';
export {
  createOrchestratorRunRepository,
  type OrchestratorRunRepositoryDeps,
  type OrchestratorRunRepository,
  type OrchestratorRunRow,
  type ClaimArgs,
} from './orchestrator-run-repository.js';
