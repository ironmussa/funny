/**
 * WebSocket event handlers for thread-store.
 *
 * Each handler patches a single source of truth — `threadDataById` via
 * `mutations.applyThreadDataPatch`. The mutation helper mirrors onto the
 * `activeThread` field iff the patched thread is the currently-selected
 * one, so the right pane stays in sync without a separate write path.
 *
 * Threads visible only in a live column (no `selectedThreadId` match) get
 * the same patch through the same map — no per-surface duplication.
 *
 * If the thread isn't loaded into `threadDataById` yet (rare: WS arrived
 * during a select that hasn't hydrated) the event is buffered and
 * replayed once `selectThread` lands the snapshot.
 *
 * The handlers live in `thread-ws-handlers/`, one module per event family;
 * this module is their public entry.
 */

export { handleWSError } from './thread-ws-handlers/error-handler';
export {
  handleWSInit,
  handleWSMessage,
  handleWSToolCall,
  handleWSToolOutput,
} from './thread-ws-handlers/message-handlers';
export { handleWSResult } from './thread-ws-handlers/result-handler';
export {
  handleWSAgentAccount,
  handleWSCompactBoundary,
  handleWSContextUsage,
  handleWSQueueUpdate,
} from './thread-ws-handlers/session-handlers';
export { handleWSStageChanged, handleWSStatus } from './thread-ws-handlers/status-handlers';
