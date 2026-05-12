/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: thread:created, thread:stage-changed, thread:deleted
 * @domain depends: ThreadRepository, AgentRunner, WorktreeManager, WSBroker
 *
 * Barrel file — re-exports the thread-service public API from the split modules
 * under ./thread-service/. See ./thread-service/helpers.ts, create.ts, messaging.ts,
 * and update.ts.
 */

export {
  ThreadServiceError,
  slugifyTitle,
  createSetupProgressEmitter,
  emitThreadUpdated,
  emitAgentFailed,
} from './thread-service/helpers.js';

export {
  createIdleThread,
  createAndStartThread,
  type CreateIdleThreadParams,
  type CreateAndStartThreadParams,
} from './thread-service/create.js';

export {
  sendMessage,
  stopThread,
  approveToolCall,
  cancelQueuedMessage,
  updateQueuedMessage,
  deleteComment,
  type SendMessageParams,
  type SendMessageResult,
  type ApproveToolParams,
} from './thread-service/messaging.js';

export {
  updateThread,
  deleteThread,
  convertToWorktree,
  type UpdateThreadParams,
} from './thread-service/update.js';

export { forkThread, type ForkThreadParams } from './thread-service/fork.js';

export {
  rewindCode,
  forkAndRewind,
  type RewindCodeParams,
  type RewindCodeResult,
  type ForkAndRewindParams,
  type ForkAndRewindResult,
} from './thread-service/rewind.js';
