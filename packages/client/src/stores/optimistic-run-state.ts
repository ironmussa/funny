/**
 * What a thread looked like just before a send marked it `running`
 * optimistically, so the mark can be undone when the send turns out not to have
 * started anything (it failed, or was handled locally).
 *
 * The snapshot is dropped as soon as the server says anything about the
 * thread's status: from then on the server's word stands and there is nothing
 * to undo.
 */
import type { ThreadStatus, WaitingReason } from '@funny/shared';

export interface PreSendRunState {
  status: ThreadStatus;
  waitingReason?: WaitingReason;
  pendingPermission?: { toolName: string; toolInput?: string };
  initialPrompt?: string;
}

const preSendStates = new Map<string, PreSendRunState>();

export function rememberPreSendState(threadId: string, state: PreSendRunState): void {
  preSendStates.set(threadId, state);
}

/** The snapshot for a thread, removed: it can be undone only once. */
export function takePreSendState(threadId: string): PreSendRunState | undefined {
  const state = preSendStates.get(threadId);
  preSendStates.delete(threadId);
  return state;
}

/** The server reported the thread's status: the optimistic mark is settled. */
export function settlePreSendState(threadId: string): void {
  preSendStates.delete(threadId);
}
