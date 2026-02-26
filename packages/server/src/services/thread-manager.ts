/**
 * Thread manager — barrel re-export.
 *
 * The original monolithic thread-manager has been split into focused modules:
 *   - thread-repository.ts  — Thread CRUD (list, get, create, update, delete)
 *   - message-repository.ts — Message CRUD + thread-with-messages queries
 *   - tool-call-repository.ts — ToolCall CRUD
 *   - comment-repository.ts — Comment CRUD + counts
 *   - search-service.ts     — FTS5 / LIKE content search
 *   - stage-history.ts      — Stage transition recording
 *
 * This file re-exports everything so existing `import * as tm` consumers
 * continue to work unchanged.
 */

// Thread CRUD
export {
  listThreads,
  listArchivedThreads,
  getThread,
  getThreadByExternalRequestId,
  createThread,
  updateThread,
  deleteThread,
  markStaleThreadsInterrupted,
  markStaleExternalThreadsStopped,
} from './thread-repository.js';

// Message CRUD + enriched queries
export {
  getThreadWithMessages,
  getThreadMessages,
  insertMessage,
  updateMessage,
} from './message-repository.js';

// ToolCall CRUD
export {
  insertToolCall,
  updateToolCallOutput,
  findToolCall,
  getToolCall,
  findLastUnansweredInteractiveToolCall,
} from './tool-call-repository.js';

// Comment CRUD
export {
  listComments,
  insertComment,
  deleteComment,
  getCommentCounts,
} from './comment-repository.js';

// Search
export { searchThreadIdsByContent } from './search-service.js';
