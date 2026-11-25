/**
 * WebSocket event actions of the thread store (delegated to
 * `thread-ws-handlers`), worktree setup progress, and the agent lifecycle
 * actions that call the API directly.
 */
import type { Thread } from '@funny/shared';

import { readThreadRow } from '@/data/threads/read';
import { api } from '@/lib/api';
import type { GitProgressStep } from '@/lib/git-progress-types';

import { transitionThreadStatus } from './thread-machine-bridge';
import * as mutations from './thread-mutations';
import { patchThreadRow } from './thread-row-writes';
import type { ThreadState } from './thread-state';
import { setBufferedInitInfo } from './thread-store-internals';
import * as wsHandlers from './thread-ws-handlers';
import type { Get, Set } from './thread-ws-handlers/shared';

type WSActions = Pick<
  ThreadState,
  | 'handleWSInit'
  | 'handleWSMessage'
  | 'handleWSToolCall'
  | 'handleWSToolOutput'
  | 'handleWSStatus'
  | 'handleWSStageChanged'
  | 'handleWSError'
  | 'handleWSResult'
  | 'handleWSQueueUpdate'
  | 'handleWSCompactBoundary'
  | 'handleWSContextUsage'
>;

type WorktreeSetupData = Parameters<ThreadState['handleWSWorktreeSetup']>[1];

const isFinished = (status: GitProgressStep['status'] | undefined) =>
  status === 'completed' || status === 'failed';

/** A step's start and end times after `data`, kept across component remounts. */
function stepTimes(
  existing: GitProgressStep | undefined,
  status: WorktreeSetupData['status'],
  now: number,
): Pick<GitProgressStep, 'startedAt' | 'completedAt'> {
  // A finished step that runs again is a new attempt (a retried setup):
  // it starts now and has not finished, instead of showing as running
  // with the previous attempt's end time.
  const prev: Partial<GitProgressStep> = existing ?? {};
  if (status === 'running' && isFinished(prev.status)) {
    return { startedAt: now, completedAt: undefined };
  }
  const times = { startedAt: prev.startedAt, completedAt: prev.completedAt };
  if (status === 'running') times.startedAt ||= now;
  if (isFinished(status)) times.completedAt ||= now;
  return times;
}

/** Fold one worktree setup event into a thread's step list, with timestamps
 *  that survive component remounts. */
function nextSetupProgress(
  prev: GitProgressStep[],
  data: WorktreeSetupData,
  now: number,
): GitProgressStep[] {
  const existing = prev.find((s) => s.id === data.step);
  const step: GitProgressStep = {
    id: data.step,
    label: data.label,
    status: data.status,
    error: data.error,
    ...stepTimes(existing, data.status, now),
  };
  const idx = existing ? prev.indexOf(existing) : -1;
  return idx >= 0 ? prev.map((s, i) => (i === idx ? { ...s, ...step } : s)) : [...prev, step];
}

export function createWSActions(set: Set, get: Get): WSActions {
  return {
    handleWSInit: (threadId, data) => {
      // Apply directly when the thread is hydrated (right pane OR live column).
      // Otherwise buffer so the next selectThread / register can pick it up.
      if (get().threadDataById[threadId]) {
        wsHandlers.handleWSInit(get, set, threadId, data);
      } else {
        setBufferedInitInfo(threadId, data);
      }
    },
    handleWSMessage: (threadId, data) => wsHandlers.handleWSMessage(get, set, threadId, data),
    handleWSToolCall: (threadId, data) => wsHandlers.handleWSToolCall(get, set, threadId, data),
    handleWSToolOutput: (threadId, data) => wsHandlers.handleWSToolOutput(get, set, threadId, data),
    handleWSStatus: (threadId, data) => wsHandlers.handleWSStatus(get, set, threadId, data),
    handleWSStageChanged: (threadId, data) =>
      wsHandlers.handleWSStageChanged(get, set, threadId, data),
    handleWSError: (threadId, data) => wsHandlers.handleWSError(get, set, threadId, data),
    handleWSResult: (threadId, data) => wsHandlers.handleWSResult(get, set, threadId, data),
    handleWSQueueUpdate: (threadId, data) =>
      wsHandlers.handleWSQueueUpdate(get, set, threadId, data),
    handleWSCompactBoundary: (threadId, data) =>
      wsHandlers.handleWSCompactBoundary(get, set, threadId, data),
    handleWSContextUsage: (threadId, data) => wsHandlers.handleWSContextUsage(threadId, data),
  };
}

export function createWorktreeSetupActions(
  set: Set,
  get: Get,
): Pick<ThreadState, 'handleWSWorktreeSetup' | 'handleWSWorktreeSetupComplete'> {
  return {
    handleWSWorktreeSetup: (threadId, data) => {
      const now = Date.now();
      set((state) => {
        const next = nextSetupProgress(state.setupProgressByThread[threadId] ?? [], data, now);
        return {
          // Always persist to the byThread map so it survives thread switches
          setupProgressByThread: {
            ...state.setupProgressByThread,
            [threadId]: next,
          },
          // Mirror onto the loaded payload (right pane OR live column). The
          // patch is a no-op when the thread isn't loaded.
          ...mutations.applyThreadDataPatch(state, threadId, (t) =>
            t.status === 'setting_up' ? { ...t, setupProgress: next } : t,
          ),
        };
      });
    },

    handleWSWorktreeSetupComplete: (threadId, data) => {
      const { loadThreadsForProject } = get();
      const setupDone = <T extends Thread>(t: T): T => ({
        ...t,
        // setting_up → pending; any other status is left alone.
        status: transitionThreadStatus(threadId, { type: 'SETUP_COMPLETE' }, t.status, t.cost),
        branch: data.branch,
        worktreePath: data.worktreePath || t.worktreePath,
      });

      patchThreadRow(threadId, setupDone);
      set((state) => {
        const { [threadId]: _, ...restProgress } = state.setupProgressByThread;
        return {
          setupProgressByThread: restProgress,
          ...mutations.applyThreadDataPatch(state, threadId, (t) => ({
            ...setupDone(t),
            setupProgress: undefined,
          })),
        };
      });

      // Refresh thread list so sidebar picks up the new status. Look up the
      // project from the unified payload map (or the sidebar index as fallback).
      const t = get().threadDataById[threadId] ?? readThreadRow(threadId);
      if (t?.projectId) {
        loadThreadsForProject(t.projectId);
      }
    },
  };
}

export function createAgentActions(): Pick<
  ThreadState,
  'sendMessage' | 'stopThread' | 'approveTool' | 'searchThreadContent'
> {
  return {
    sendMessage: async (threadId, content, options) => {
      const result = await api.sendMessage(
        threadId,
        content,
        options ? { model: options.model, permissionMode: options.permissionMode } : undefined,
        options?.images,
      );
      if (result.isErr()) return false;
      return true;
    },

    stopThread: async (threadId) => {
      await api.stopThread(threadId);
    },

    approveTool: async (threadId, toolName, approved, allowedTools, disallowedTools, options) => {
      const result = await api.approveTool(
        threadId,
        toolName,
        approved,
        allowedTools,
        disallowedTools,
        options,
      );
      return result.isOk();
    },

    searchThreadContent: async (query, projectId) => {
      const result = await api.searchThreadContent(query, projectId);
      return result.isOk() ? result.value : null;
    },
  };
}
