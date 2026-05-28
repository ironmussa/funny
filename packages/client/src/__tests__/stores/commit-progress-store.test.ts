import { describe, test, expect, beforeEach } from 'vitest';

import { useCommitProgressStore } from '@/stores/commit-progress-store';

describe('useCommitProgressStore', () => {
  beforeEach(() => {
    useCommitProgressStore.setState({ activeCommits: {}, failedWorkflow: null });
  });

  describe('startCommit', () => {
    test('adds an entry with title, steps, and action', () => {
      const steps = [
        { id: 'stage', label: 'Staging files', status: 'pending' as const },
        { id: 'commit', label: 'Creating commit', status: 'pending' as const },
      ];

      useCommitProgressStore.getState().startCommit('t1', 'Committing changes', steps, 'commit');

      const entry = useCommitProgressStore.getState().activeCommits['t1'];
      expect(entry).toBeDefined();
      expect(entry.title).toBe('Committing changes');
      expect(entry.steps).toEqual(steps);
      expect(entry.action).toBe('commit');
    });

    test('stores optional workflowId', () => {
      const steps = [{ id: 'stage', label: 'Staging', status: 'pending' as const }];
      useCommitProgressStore.getState().startCommit('t1', 'Committing', steps, 'commit', 'wf-1');

      expect(useCommitProgressStore.getState().activeCommits.t1.workflowId).toBe('wf-1');
    });
  });

  describe('updateStep', () => {
    test('updates a specific step by id', () => {
      const steps = [
        { id: 'stage', label: 'Staging files', status: 'pending' as const },
        { id: 'commit', label: 'Creating commit', status: 'pending' as const },
      ];
      useCommitProgressStore.getState().startCommit('t1', 'Committing', steps, 'commit');

      useCommitProgressStore.getState().updateStep('t1', 'stage', { status: 'completed' });

      const entry = useCommitProgressStore.getState().activeCommits['t1'];
      expect(entry.steps[0].status).toBe('completed');
      expect(entry.steps[1].status).toBe('pending');
    });

    test('updates step with error information', () => {
      const steps = [{ id: 'push', label: 'Pushing to remote', status: 'running' as const }];
      useCommitProgressStore.getState().startCommit('t1', 'Pushing', steps, 'push');

      useCommitProgressStore.getState().updateStep('t1', 'push', {
        status: 'failed',
        error: 'Remote rejected',
      });

      const entry = useCommitProgressStore.getState().activeCommits['t1'];
      expect(entry.steps[0].status).toBe('failed');
      expect(entry.steps[0].error).toBe('Remote rejected');
    });

    test('is no-op for non-existent commit id', () => {
      const stateBefore = useCommitProgressStore.getState().activeCommits;
      useCommitProgressStore.getState().updateStep('nonexistent', 'stage', { status: 'completed' });
      const stateAfter = useCommitProgressStore.getState().activeCommits;
      expect(stateAfter).toEqual(stateBefore);
    });
  });

  describe('replaceSteps', () => {
    test('replaces all steps for an active commit', () => {
      const initial = [{ id: 'stage', label: 'Staging', status: 'pending' as const }];
      const replacement = [{ id: 'push', label: 'Pushing', status: 'running' as const }];

      useCommitProgressStore.getState().startCommit('t1', 'Committing', initial, 'commit');
      useCommitProgressStore.getState().replaceSteps('t1', replacement);

      expect(useCommitProgressStore.getState().activeCommits.t1.steps).toEqual(replacement);
    });

    test('is a no-op for unknown commit id', () => {
      useCommitProgressStore.getState().replaceSteps('missing', []);
      expect(useCommitProgressStore.getState().activeCommits).toEqual({});
    });
  });

  describe('failed workflow modal state', () => {
    test('stores and clears failed workflow entries', () => {
      const entry = {
        title: 'Push failed',
        action: 'push',
        steps: [{ id: 'push', label: 'Pushing', status: 'failed' as const, error: 'denied' }],
      };

      useCommitProgressStore.getState().setFailedWorkflow(entry);
      expect(useCommitProgressStore.getState().failedWorkflow).toEqual(entry);

      useCommitProgressStore.getState().clearFailedWorkflow();
      expect(useCommitProgressStore.getState().failedWorkflow).toBeNull();
    });
  });

  describe('finishCommit', () => {
    test('removes the entry', () => {
      const steps = [{ id: 'stage', label: 'Staging', status: 'completed' as const }];
      useCommitProgressStore.getState().startCommit('t1', 'Committing', steps, 'commit');
      expect(useCommitProgressStore.getState().activeCommits['t1']).toBeDefined();

      useCommitProgressStore.getState().finishCommit('t1');
      expect(useCommitProgressStore.getState().activeCommits['t1']).toBeUndefined();
    });

    test('does not affect other entries', () => {
      const steps = [{ id: 's1', label: 'Step', status: 'pending' as const }];
      useCommitProgressStore.getState().startCommit('t1', 'First', steps, 'commit');
      useCommitProgressStore.getState().startCommit('t2', 'Second', steps, 'push');

      useCommitProgressStore.getState().finishCommit('t1');

      expect(useCommitProgressStore.getState().activeCommits['t1']).toBeUndefined();
      expect(useCommitProgressStore.getState().activeCommits['t2']).toBeDefined();
    });
  });

  describe('concurrent commits', () => {
    test('multiple concurrent commits can coexist', () => {
      const steps1 = [{ id: 'stage', label: 'Staging', status: 'pending' as const }];
      const steps2 = [{ id: 'push', label: 'Pushing', status: 'running' as const }];

      useCommitProgressStore.getState().startCommit('t1', 'Commit A', steps1, 'commit');
      useCommitProgressStore.getState().startCommit('t2', 'Push B', steps2, 'push');

      const commits = useCommitProgressStore.getState().activeCommits;
      expect(Object.keys(commits)).toHaveLength(2);
      expect(commits['t1'].title).toBe('Commit A');
      expect(commits['t2'].title).toBe('Push B');
    });
  });
});
