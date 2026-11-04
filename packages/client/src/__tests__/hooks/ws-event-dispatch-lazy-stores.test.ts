import { afterEach, describe, expect, test, vi } from 'vitest';

import { getRunsData } from '@/data/automations/store';
import { seedAutomations } from '@/data/automations/testing';
import { getJobsData, getWatchersData } from '@/data/background/store';
import { getCommentsData } from '@/data/comments/store';
import { getSchedulerData } from '@/data/scheduler/store';
import { readThreadIndex } from '@/data/threads/read';
import { withThreadIndex } from '@/data/threads/testing';
import { clearWSDispatchState, dispatchRealtimeEvent } from '@/hooks/ws-event-dispatch';
import { useNativeGitStore } from '@/stores/native-git-store';
import { usePipelineApprovalStore } from '@/stores/pipeline-approval-store';
import { usePipelineStore } from '@/stores/pipeline-store';
import { usePresenceStore } from '@/stores/presence-store';
import { useThreadStore } from '@/stores/thread-store';
import { setAppNavigate } from '@/stores/thread-store-internals';
import { useWorkflowRunStore } from '@/stores/workflow-run-store';

// The handler table lazily `import()`s these stores. Spy on the real store
// actions (rather than `vi.mock`ing the modules) so every dynamic import
// resolves to the same instance the spies are installed on.
function spyActions<S extends { setState: (patch: any) => void }>(
  store: S,
  names: string[],
): Record<string, ReturnType<typeof vi.fn>> {
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of names) spies[name] = vi.fn();
  store.setState(spies);
  return spies;
}

describe('ws-event-dispatch — lazily-imported store routing', () => {
  afterEach(() => {
    clearWSDispatchState();
  });

  test('automation run events are synced writes into a loaded run history', () => {
    seedAutomations({
      runs: [
        {
          id: 'old',
          automationId: 'a1',
          threadId: 't0',
          status: 'completed',
          triageStatus: 'pending',
          startedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    dispatchRealtimeEvent('automation:run_started', 't1', { automationId: 'a1', runId: 'r1' });
    expect(getRunsData().getSynced('r1')).toMatchObject({ status: 'running', threadId: 't1' });
    dispatchRealtimeEvent('automation:run_updated', 't1', {
      runId: 'old',
      triageStatus: 'reviewed',
    });
    expect(getRunsData().getSynced('old')?.triageStatus).toBe('reviewed');
  });

  test('watcher and job events upsert only when the payload carries the entity', () => {
    const jobs = getJobsData();
    const watchers = getWatchersData();
    dispatchRealtimeEvent('watcher:cancelled', 't1', {});
    dispatchRealtimeEvent('job:killed', 't1', {});
    expect(jobs.collection.size + watchers.collection.size).toBe(0);
    dispatchRealtimeEvent('watcher:fired', 't1', { watcher: { id: 'w1' } });
    dispatchRealtimeEvent('job:exited', 't1', { job: { id: 'j1' } });
    expect(watchers.getSynced('w1')).toEqual({ id: 'w1' });
    expect(jobs.getSynced('j1')).toEqual({ id: 'j1' });
  });

  test('pipeline, approval and workflow events route to their stores', async () => {
    const p = spyActions(usePipelineStore, [
      'handlePipelineStarted',
      'handlePipelineStageUpdate',
      'handlePipelineCompleted',
    ]);
    const a = spyActions(usePipelineApprovalStore, [
      'handleApprovalRequested',
      'handleApprovalResolved',
    ]);
    const wf = spyActions(useWorkflowRunStore, ['handleNodeState']);
    dispatchRealtimeEvent('pipeline:run_started', 't1', { a: 1 });
    dispatchRealtimeEvent('pipeline:stage_update', 't1', { a: 2 });
    dispatchRealtimeEvent('pipeline:run_completed', 't1', { a: 3 });
    dispatchRealtimeEvent('pipeline:approval_requested', 't1', { b: 1 });
    dispatchRealtimeEvent('pipeline:approval_resolved', 't1', { b: 2 });
    dispatchRealtimeEvent('workflow:node_state', 't1', { c: 1 });
    await vi.waitFor(() => {
      expect(p.handlePipelineStarted).toHaveBeenCalledWith({ a: 1 });
      expect(p.handlePipelineStageUpdate).toHaveBeenCalledWith({ a: 2 });
      expect(p.handlePipelineCompleted).toHaveBeenCalledWith({ a: 3 });
      expect(a.handleApprovalRequested).toHaveBeenCalledWith({ b: 1 });
      expect(a.handleApprovalResolved).toHaveBeenCalledWith({ b: 2 });
      expect(wf.handleNodeState).toHaveBeenCalledWith({ c: 1 });
    });
  });

  test('scheduler events patch the run row and release removes it', () => {
    const runs = getSchedulerData();
    dispatchRealtimeEvent('thread:claimed', 't1', { userId: 'u1', attempt: 1 });
    expect(runs.getSynced('t1')).toMatchObject({ userId: 'u1', attempt: 1 });
    dispatchRealtimeEvent('thread:dispatched', 't1', { pipelineRunId: 'pr1' });
    dispatchRealtimeEvent('thread:retry-queued', 't1', { attempt: 2, dueAtMs: 5, error: 'x' });
    expect(runs.getSynced('t1')).toMatchObject({
      pipelineRunId: 'pr1',
      attempt: 2,
      nextRetryAtMs: 5,
      lastError: 'x',
    });
    dispatchRealtimeEvent('thread:released', 't1', {});
    expect(runs.getSynced('t1')).toBeUndefined();
  });

  test('presence events route to the presence store', async () => {
    const s = spyActions(usePresenceStore, ['setRoster', 'upsertViewer', 'removeViewer']);
    dispatchRealtimeEvent('presence:join', 't1', {});
    dispatchRealtimeEvent('presence:sync', 't1', {});
    dispatchRealtimeEvent('presence:join', 't1', { viewer: { clientId: 'c1' } });
    dispatchRealtimeEvent('presence:leave', 't1', { clientId: 'c1' });
    await vi.waitFor(() => {
      expect(s.setRoster).toHaveBeenCalledWith('t1', []);
      expect(s.upsertViewer).toHaveBeenCalledWith('t1', { clientId: 'c1' });
      expect(s.removeViewer).toHaveBeenCalledWith('t1', 'c1');
    });
    expect(s.upsertViewer).toHaveBeenCalledTimes(1);
  });

  test('share revoke clears presence and drops the thread; share grant reloads shared', async () => {
    const presence = spyActions(usePresenceStore, ['clearThread']);
    const thread = spyActions(useThreadStore, ['handleShareRevoked', 'loadSharedThreads']);
    thread.loadSharedThreads.mockResolvedValue(undefined);

    dispatchRealtimeEvent('thread:share-revoked', 't1', {});
    dispatchRealtimeEvent('thread:share-granted', 't2', {});
    expect(thread.handleShareRevoked).toHaveBeenCalledWith('t1');
    expect(thread.loadSharedThreads).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(presence.clearThread).toHaveBeenCalledWith('t1');
    });
  });

  test('thread:deleted drops the thread and leaves its open view', async () => {
    const thread = spyActions(useThreadStore, ['handleThreadDeleted']);
    const presence = spyActions(usePresenceStore, ['clearThread']);
    const navigate = vi.fn();
    setAppNavigate(navigate);
    window.history.pushState({}, '', '/projects/p1/threads/t-open');

    dispatchRealtimeEvent('thread:deleted', 't-other', { projectId: 'p1' });
    expect(thread.handleThreadDeleted).toHaveBeenCalledWith('t-other');
    expect(navigate).not.toHaveBeenCalled();

    dispatchRealtimeEvent('thread:deleted', 't-open', { projectId: 'p1' });
    expect(thread.handleThreadDeleted).toHaveBeenCalledWith('t-open');
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining('/projects/p1'));
    await vi.waitFor(() => {
      expect(presence.clearThread).toHaveBeenCalledWith('t-open');
    });
  });

  test('comment events update the comments and the thread badge in the same tick', () => {
    useThreadStore.setState(
      withThreadIndex({
        threadsById: { t1: { id: 't1', projectId: 'p1', commentCount: 1 } as any },
      }),
    );

    dispatchRealtimeEvent('thread:comment', 't1', { comment: { id: 'c1', threadId: 't1' } });
    expect(readThreadIndex().threadsById.t1?.commentCount).toBe(2);
    expect(getCommentsData().getSynced('c1')).toBeDefined();
    dispatchRealtimeEvent('thread:comment_deleted', 't1', { commentId: 'c1' });
    expect(readThreadIndex().threadsById.t1?.commentCount).toBe(1);
    expect(getCommentsData().getSynced('c1')).toBeUndefined();
  });

  test('native-git build events route by type', async () => {
    const s = spyActions(useNativeGitStore, ['appendBuildOutput', 'setBuildStatus']);
    dispatchRealtimeEvent('native-git:build_output', '', { text: 'compiling' });
    dispatchRealtimeEvent('native-git:build_status', '', { status: 'done', exitCode: 0 });
    await vi.waitFor(() => {
      expect(s.appendBuildOutput).toHaveBeenCalledWith('compiling');
      expect(s.setBuildStatus).toHaveBeenCalledWith('done', 0);
    });
  });

  test('unknown and Object.prototype event names are ignored', () => {
    expect(() => dispatchRealtimeEvent('nope:unknown', 't1', {})).not.toThrow();
    expect(() => dispatchRealtimeEvent('toString', 't1', {})).not.toThrow();
    expect(() => dispatchRealtimeEvent('constructor', 't1', {})).not.toThrow();
    // Would throw ("Expecting function") if prototype members were dispatched.
    expect(() => dispatchRealtimeEvent('__defineGetter__', 't1', {})).not.toThrow();
  });
});
