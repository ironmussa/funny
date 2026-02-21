/**
 * E2E test: Workflow Store
 *
 * Tests the full client-side flow of triggering a workflow,
 * receiving WebSocket status updates, and tracking step progress.
 *
 * Flow tested:
 *   1. triggerWorkflow() → API call → creates run in store
 *   2. handleWorkflowStatus() → updates run status (running → completed)
 *   3. handleWorkflowStep() → adds/updates steps with status icons
 *   4. selectRun() → navigates between run list and detail view
 *   5. Edge cases: unknown runs, quality scores, failed workflows
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Mock the API module
const mockTriggerWorkflow = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    triggerWorkflow: mockTriggerWorkflow,
  },
}));

import { useWorkflowStore } from '@/stores/workflow-store';
import type { WSWorkflowStepData, WSWorkflowStatusData } from '@funny/shared';

describe('useWorkflowStore', () => {
  beforeEach(() => {
    mockTriggerWorkflow.mockReset();
    // Reset store to initial state
    useWorkflowStore.setState({
      runs: [],
      selectedRunId: null,
    });
  });

  // ── triggerWorkflow ───────────────────────────────────────

  describe('triggerWorkflow', () => {
    test('creates a new run on successful trigger', async () => {
      mockTriggerWorkflow.mockResolvedValue({
        isErr: () => false,
        value: { run_id: 'run-123', status: 'triggered' },
      });

      const runId = await useWorkflowStore.getState().triggerWorkflow(
        'feature-to-deploy',
        { prompt: 'Add auth', branch: 'main' },
        'project-1',
      );

      expect(runId).toBe('run-123');

      const state = useWorkflowStore.getState();
      expect(state.runs).toHaveLength(1);
      expect(state.runs[0].runId).toBe('run-123');
      expect(state.runs[0].workflowName).toBe('feature-to-deploy');
      expect(state.runs[0].projectId).toBe('project-1');
      expect(state.runs[0].status).toBe('triggered');
      expect(state.runs[0].steps).toHaveLength(0);
      expect(state.selectedRunId).toBe('run-123');
    });

    test('returns null on API error', async () => {
      mockTriggerWorkflow.mockResolvedValue({
        isErr: () => true,
        error: { message: 'Hatchet not configured' },
      });

      const runId = await useWorkflowStore.getState().triggerWorkflow(
        'cleanup',
        {},
        'project-1',
      );

      expect(runId).toBeNull();
      expect(useWorkflowStore.getState().runs).toHaveLength(0);
    });

    test('prepends new runs (most recent first)', async () => {
      mockTriggerWorkflow.mockResolvedValueOnce({
        isErr: () => false,
        value: { run_id: 'run-1' },
      });
      await useWorkflowStore.getState().triggerWorkflow('cleanup', {}, 'p1');

      mockTriggerWorkflow.mockResolvedValueOnce({
        isErr: () => false,
        value: { run_id: 'run-2' },
      });
      await useWorkflowStore.getState().triggerWorkflow('doc-gardening', {}, 'p1');

      const { runs } = useWorkflowStore.getState();
      expect(runs).toHaveLength(2);
      expect(runs[0].runId).toBe('run-2');
      expect(runs[1].runId).toBe('run-1');
    });
  });

  // ── selectRun ─────────────────────────────────────────────

  describe('selectRun', () => {
    test('sets selectedRunId', () => {
      useWorkflowStore.getState().selectRun('run-42');
      expect(useWorkflowStore.getState().selectedRunId).toBe('run-42');
    });

    test('clears selectedRunId with null', () => {
      useWorkflowStore.getState().selectRun('run-42');
      useWorkflowStore.getState().selectRun(null);
      expect(useWorkflowStore.getState().selectedRunId).toBeNull();
    });
  });

  // ── handleWorkflowStatus ──────────────────────────────────

  describe('handleWorkflowStatus', () => {
    test('updates existing run status to running', () => {
      useWorkflowStore.setState({
        runs: [{
          runId: 'run-1',
          workflowName: 'feature-to-deploy',
          projectId: 'p1',
          status: 'triggered',
          steps: [],
          startedAt: '2026-02-20T10:00:00Z',
        }],
      });

      useWorkflowStore.getState().handleWorkflowStatus({
        runId: 'run-1',
        workflowName: 'feature-to-deploy',
        status: 'running',
      });

      expect(useWorkflowStore.getState().runs[0].status).toBe('running');
      expect(useWorkflowStore.getState().runs[0].completedAt).toBeUndefined();
    });

    test('sets completedAt when status is completed', () => {
      useWorkflowStore.setState({
        runs: [{
          runId: 'run-1',
          workflowName: 'cleanup',
          projectId: 'p1',
          status: 'running',
          steps: [],
          startedAt: '2026-02-20T10:00:00Z',
        }],
      });

      useWorkflowStore.getState().handleWorkflowStatus({
        runId: 'run-1',
        workflowName: 'cleanup',
        status: 'completed',
      });

      const run = useWorkflowStore.getState().runs[0];
      expect(run.status).toBe('completed');
      expect(run.completedAt).toBeDefined();
    });

    test('adds quality scores when provided', () => {
      useWorkflowStore.setState({
        runs: [{
          runId: 'run-1',
          workflowName: 'feature-to-deploy',
          projectId: 'p1',
          status: 'running',
          steps: [],
          startedAt: '2026-02-20T10:00:00Z',
        }],
      });

      const scores = {
        tests: { status: 'pass', details: 'All 42 tests pass' },
        security: { status: 'pass', details: 'No vulnerabilities' },
        style: { status: 'fail', details: '3 lint errors' },
      };

      useWorkflowStore.getState().handleWorkflowStatus({
        runId: 'run-1',
        workflowName: 'feature-to-deploy',
        status: 'completed',
        qualityScores: scores,
      });

      const run = useWorkflowStore.getState().runs[0];
      expect(run.qualityScores).toEqual(scores);
    });

    test('creates a new run if not tracked locally', () => {
      // Simulates a run triggered from another tab/client
      useWorkflowStore.getState().handleWorkflowStatus({
        runId: 'run-remote',
        workflowName: 'doc-gardening',
        status: 'running',
      });

      const { runs } = useWorkflowStore.getState();
      expect(runs).toHaveLength(1);
      expect(runs[0].runId).toBe('run-remote');
      expect(runs[0].workflowName).toBe('doc-gardening');
      expect(runs[0].status).toBe('running');
    });

    test('handles failed status with completedAt', () => {
      useWorkflowStore.setState({
        runs: [{
          runId: 'run-1',
          workflowName: 'feature-to-deploy',
          projectId: 'p1',
          status: 'running',
          steps: [],
          startedAt: '2026-02-20T10:00:00Z',
        }],
      });

      useWorkflowStore.getState().handleWorkflowStatus({
        runId: 'run-1',
        workflowName: 'feature-to-deploy',
        status: 'failed',
      });

      const run = useWorkflowStore.getState().runs[0];
      expect(run.status).toBe('failed');
      expect(run.completedAt).toBeDefined();
    });
  });

  // ── handleWorkflowStep ────────────────────────────────────

  describe('handleWorkflowStep', () => {
    test('adds a new step to the run', () => {
      useWorkflowStore.setState({
        runs: [{
          runId: 'run-1',
          workflowName: 'feature-to-deploy',
          projectId: 'p1',
          status: 'running',
          steps: [],
          startedAt: '2026-02-20T10:00:00Z',
        }],
      });

      useWorkflowStore.getState().handleWorkflowStep({
        runId: 'run-1',
        workflowName: 'feature-to-deploy',
        stepName: 'classify-tier',
        status: 'completed',
      });

      const steps = useWorkflowStore.getState().runs[0].steps;
      expect(steps).toHaveLength(1);
      expect(steps[0].name).toBe('classify-tier');
      expect(steps[0].status).toBe('completed');
      expect(steps[0].completedAt).toBeDefined();
    });

    test('updates existing step status', () => {
      useWorkflowStore.setState({
        runs: [{
          runId: 'run-1',
          workflowName: 'feature-to-deploy',
          projectId: 'p1',
          status: 'running',
          steps: [{ name: 'run-agent', status: 'running' }],
          startedAt: '2026-02-20T10:00:00Z',
        }],
      });

      useWorkflowStore.getState().handleWorkflowStep({
        runId: 'run-1',
        workflowName: 'feature-to-deploy',
        stepName: 'run-agent',
        status: 'completed',
        output: { fixes_applied: 3 },
      });

      const steps = useWorkflowStore.getState().runs[0].steps;
      expect(steps).toHaveLength(1);
      expect(steps[0].status).toBe('completed');
      expect(steps[0].output).toEqual({ fixes_applied: 3 });
    });

    test('does not add step to unrelated runs', () => {
      useWorkflowStore.setState({
        runs: [
          {
            runId: 'run-1',
            workflowName: 'cleanup',
            projectId: 'p1',
            status: 'running',
            steps: [],
            startedAt: '2026-02-20T10:00:00Z',
          },
          {
            runId: 'run-2',
            workflowName: 'doc-gardening',
            projectId: 'p1',
            status: 'running',
            steps: [],
            startedAt: '2026-02-20T10:00:00Z',
          },
        ],
      });

      useWorkflowStore.getState().handleWorkflowStep({
        runId: 'run-1',
        workflowName: 'cleanup',
        stepName: 'remove-branches',
        status: 'completed',
      });

      expect(useWorkflowStore.getState().runs[0].steps).toHaveLength(1);
      expect(useWorkflowStore.getState().runs[1].steps).toHaveLength(0);
    });
  });

  // ── Full lifecycle ────────────────────────────────────────

  describe('full lifecycle', () => {
    test('trigger → running → steps complete → workflow complete with scores', async () => {
      // 1. Trigger
      mockTriggerWorkflow.mockResolvedValue({
        isErr: () => false,
        value: { run_id: 'run-e2e' },
      });

      await useWorkflowStore.getState().triggerWorkflow(
        'feature-to-deploy',
        { prompt: 'Add dark mode' },
        'project-1',
      );

      let state = useWorkflowStore.getState();
      expect(state.runs[0].status).toBe('triggered');

      // 2. Workflow starts running (WS event)
      state.handleWorkflowStatus({
        runId: 'run-e2e',
        workflowName: 'feature-to-deploy',
        status: 'running',
      });
      expect(useWorkflowStore.getState().runs[0].status).toBe('running');

      // 3. Steps complete one by one (WS events)
      const stepNames = ['classify-tier', 'create-worktree', 'run-agent', 'quality-pipeline', 'wait-for-approval'];

      for (const step of stepNames) {
        useWorkflowStore.getState().handleWorkflowStep({
          runId: 'run-e2e',
          workflowName: 'feature-to-deploy',
          stepName: step,
          status: 'completed',
        });
      }

      expect(useWorkflowStore.getState().runs[0].steps).toHaveLength(5);
      expect(useWorkflowStore.getState().runs[0].steps.every(s => s.status === 'completed')).toBe(true);

      // 4. Workflow completes with quality scores (WS event)
      useWorkflowStore.getState().handleWorkflowStatus({
        runId: 'run-e2e',
        workflowName: 'feature-to-deploy',
        status: 'completed',
        qualityScores: {
          tests: { status: 'pass', details: 'All tests pass' },
          security: { status: 'pass', details: 'Clean' },
        },
      });

      const finalRun = useWorkflowStore.getState().runs[0];
      expect(finalRun.status).toBe('completed');
      expect(finalRun.completedAt).toBeDefined();
      expect(finalRun.qualityScores).toBeDefined();
      expect(Object.keys(finalRun.qualityScores!)).toHaveLength(2);
    });

    test('trigger → running → step fails → workflow fails', async () => {
      mockTriggerWorkflow.mockResolvedValue({
        isErr: () => false,
        value: { run_id: 'run-fail' },
      });

      await useWorkflowStore.getState().triggerWorkflow('feature-to-deploy', {}, 'p1');

      // Running
      useWorkflowStore.getState().handleWorkflowStatus({
        runId: 'run-fail',
        workflowName: 'feature-to-deploy',
        status: 'running',
      });

      // First step completes
      useWorkflowStore.getState().handleWorkflowStep({
        runId: 'run-fail',
        workflowName: 'feature-to-deploy',
        stepName: 'classify-tier',
        status: 'completed',
      });

      // Second step fails
      useWorkflowStore.getState().handleWorkflowStep({
        runId: 'run-fail',
        workflowName: 'feature-to-deploy',
        stepName: 'run-agent',
        status: 'failed',
      });

      // Workflow fails
      useWorkflowStore.getState().handleWorkflowStatus({
        runId: 'run-fail',
        workflowName: 'feature-to-deploy',
        status: 'failed',
      });

      const run = useWorkflowStore.getState().runs[0];
      expect(run.status).toBe('failed');
      expect(run.steps[0].status).toBe('completed');
      expect(run.steps[1].status).toBe('failed');
    });
  });
});
