import type { Thread, ThreadEvent, WaitingReason } from '@funny/shared';

import type { ThreadState } from './thread-state';
import type { AgentResultInfo, CompactionEvent, ThreadWithMessages } from './thread-types';

const PERMISSION_DENY_PATTERN =
  /requested permissions? to (?:use|edit)|is a sensitive file|hasn't been granted|hasn't granted|not in the allowed tools|hook error:.*(?:approval|permission)|denied this tool|Blocked by hook/i;

export function deriveResultInfo(thread: Thread): AgentResultInfo | undefined {
  if (thread.status !== 'completed' && thread.status !== 'failed') return undefined;
  return {
    status: thread.status,
    cost: thread.cost,
    duration: 0,
    error: (thread as Thread & { error?: string }).error,
  };
}

export type WaitingState = {
  waitingReason?: WaitingReason;
  pendingPermission?: { toolName: string };
};

export function deriveWaitingState(
  thread: Thread & { messages?: { toolCalls?: { name: string; output?: string }[] }[] },
): WaitingState {
  if (thread.status !== 'waiting' || !thread.messages?.length) return {};
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const tcs = thread.messages[i].toolCalls;
    if (!tcs?.length) continue;
    const lastTC = tcs[tcs.length - 1];
    if (lastTC.name === 'AskUserQuestion') return { waitingReason: 'question' };
    if (lastTC.name === 'ExitPlanMode') return { waitingReason: 'plan' };
    if (lastTC.output && PERMISSION_DENY_PATTERN.test(lastTC.output)) {
      return { waitingReason: 'permission', pendingPermission: { toolName: lastTC.name } };
    }
    return {};
  }
  return {};
}

export function reconstructCompactionEvents(threadEvents: ThreadEvent[]): CompactionEvent[] {
  return threadEvents
    .filter((e) => e.type === 'compact_boundary')
    .map((e) => {
      const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      return {
        trigger: data.trigger ?? 'auto',
        preTokens: data.preTokens ?? 0,
        timestamp: data.timestamp ?? e.createdAt,
      };
    });
}

export function computeNextActiveThread(
  state: ThreadState,
  threadId: string | null,
  keepStale: boolean,
  prevActive: ThreadWithMessages | null,
  isDifferentThread: boolean,
): ThreadWithMessages | null {
  const targetEntry = threadId ? (state.threadDataById[threadId] ?? null) : null;
  if (targetEntry) return targetEntry;
  if (keepStale) return prevActive;
  if (threadId && !isDifferentThread) return prevActive;
  return null;
}
