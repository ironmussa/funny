/**
 * Worktree setup progress: the steps a `setting_up` thread reports, kept per
 * thread so they survive thread switches, and the switch to `pending` when
 * setup completes.
 */

import type { Thread } from '@funny/shared';

import type { GitProgressStep } from '@/components/GitProgressModal';
import { readThreadRow } from '@/data/threads/read';

import { transitionThreadStatus } from './thread-machine-bridge';
import * as mutations from './thread-mutations';
import { patchThreadRow } from './thread-row-writes';
import type { ThreadState } from './thread-state';
import type { Get, Set } from './thread-ws-handlers/shared';

export function createWorktreeSetupActions(
  set: Set,
  get: Get,
): Pick<ThreadState, 'handleWSWorktreeSetup' | 'handleWSWorktreeSetupComplete'> {
  return {
    handleWSWorktreeSetup: (threadId, data) => {
      const now = Date.now();
      set((state) => {
        const prev = state.setupProgressByThread[threadId] ?? [];
        const existing = prev.find((s) => s.id === data.step);

        // Build step with timestamps that survive component remounts
        const step: GitProgressStep = {
          id: data.step,
          label: data.label,
          status: data.status,
          error: data.error,
          startedAt: existing?.startedAt,
          completedAt: existing?.completedAt,
        };
        // A finished step that runs again is a new attempt (a retried setup):
        // it starts now and has not finished, instead of showing as running
        // with the previous attempt's end time.
        const rerun =
          data.status === 'running' &&
          (existing?.status === 'completed' || existing?.status === 'failed');
        if (rerun) {
          step.startedAt = now;
          step.completedAt = undefined;
        }
        if (data.status === 'running' && !existing?.startedAt) {
          step.startedAt = now;
        }
        if ((data.status === 'completed' || data.status === 'failed') && !existing?.completedAt) {
          step.completedAt = now;
        }

        // Always persist to the byThread map so it survives thread switches
        const idx = existing ? prev.indexOf(existing) : -1;
        const next =
          idx >= 0 ? prev.map((s, i) => (i === idx ? { ...s, ...step } : s)) : [...prev, step];

        return {
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
