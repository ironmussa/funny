/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: git:workflow_progress (via WSBroker)
 * @domain depends: GitService, GitCore, ProjectHooksService, WSBroker
 *
 * Server-side orchestrator for multi-step git workflows (commit, push, merge, PR).
 * Replaces the imperative client-side orchestration that was in ReviewPane.tsx.
 */

import {
  stageFiles as gitStageFiles,
  unstageFiles as gitUnstageFiles,
  commit as gitCommit,
  push as gitPush,
  runHookCommand,
  invalidateStatusCache,
} from '@funny/core/git';
import type {
  GitWorkflowAction,
  GitWorkflowProgressStep,
  WSGitWorkflowProgressData,
} from '@funny/shared';

import { log } from '../lib/logger.js';
import {
  stage as gitServiceStage,
  unstage as gitServiceUnstage,
  commitChanges as gitServiceCommit,
  pushChanges as gitServicePush,
  merge as gitServiceMerge,
  createPullRequest as gitServiceCreatePR,
  resolveIdentity,
} from './git-service.js';
import { listHooks } from './project-hooks-service.js';
import { wsBroker } from './ws-broker.js';

// ── Types ────────────────────────────────────────────────────

export interface WorkflowParams {
  /** threadId for thread-scoped, projectId for project-scoped */
  contextId: string;
  threadId?: string;
  projectId?: string;
  userId: string;
  cwd: string;
  action: GitWorkflowAction;
  message?: string;
  filesToStage?: string[];
  filesToUnstage?: string[];
  amend?: boolean;
  noVerify?: boolean;
  prTitle?: string;
  prBody?: string;
  targetBranch?: string;
  cleanup?: boolean;
}

// ── Lock ─────────────────────────────────────────────────────

const activeWorkflows = new Map<string, string>();

export function isWorkflowActive(contextId: string): boolean {
  return activeWorkflows.has(contextId);
}

// ── Progress emission ────────────────────────────────────────

function emitProgress(
  userId: string,
  contextId: string,
  workflowId: string,
  status: WSGitWorkflowProgressData['status'],
  title: string,
  action: GitWorkflowAction,
  steps: GitWorkflowProgressStep[],
) {
  wsBroker.emitToUser(userId, {
    type: 'git:workflow_progress',
    threadId: contextId,
    data: { workflowId, status, title, action, steps },
  });
}

// ── Step helpers ─────────────────────────────────────────────

function markStep(
  steps: GitWorkflowProgressStep[],
  stepId: string,
  update: Partial<GitWorkflowProgressStep>,
): GitWorkflowProgressStep[] {
  return steps.map((s) => (s.id === stepId ? { ...s, ...update } : s));
}

// ── Workflow titles ──────────────────────────────────────────

const TITLES: Record<GitWorkflowAction, string> = {
  commit: 'Committing changes',
  amend: 'Amending commit',
  'commit-push': 'Commit & push',
  'commit-pr': 'Commit & create PR',
  'commit-merge': 'Commit & merge',
  push: 'Pushing',
  merge: 'Merging',
  'create-pr': 'Creating pull request',
};

// ── Step builder ─────────────────────────────────────────────

function isCommitAction(action: GitWorkflowAction): boolean {
  return ['commit', 'amend', 'commit-push', 'commit-pr', 'commit-merge'].includes(action);
}

function buildSteps(
  params: WorkflowParams,
  hooks: { label: string; command: string }[],
): GitWorkflowProgressStep[] {
  const steps: GitWorkflowProgressStep[] = [];

  if (params.filesToUnstage && params.filesToUnstage.length > 0) {
    steps.push({ id: 'unstage', label: 'Unstaging files', status: 'pending' });
  }
  if (params.filesToStage && params.filesToStage.length > 0) {
    steps.push({ id: 'stage', label: 'Staging files', status: 'pending' });
  }

  if (isCommitAction(params.action)) {
    const hookSubItems =
      hooks.length > 0
        ? hooks.map((h) => ({ label: h.label, status: 'pending' as const }))
        : undefined;
    steps.push({
      id: 'hooks',
      label: 'Running pre-commit hooks',
      status: 'pending',
      subItems: hookSubItems,
    });
    steps.push({
      id: 'commit',
      label: params.action === 'amend' ? 'Amending commit' : 'Committing',
      status: 'pending',
    });
  }

  if (['commit-push', 'commit-pr', 'push', 'create-pr'].includes(params.action)) {
    steps.push({ id: 'push', label: 'Pushing', status: 'pending' });
  }
  if (['commit-pr', 'create-pr'].includes(params.action)) {
    steps.push({ id: 'pr', label: 'Creating pull request', status: 'pending' });
  }
  if (['commit-merge', 'merge'].includes(params.action)) {
    steps.push({ id: 'merge', label: 'Merging', status: 'pending' });
  }

  return steps;
}

// ── Main executor ────────────────────────────────────────────

export function executeWorkflow(params: WorkflowParams): { workflowId: string } {
  if (activeWorkflows.has(params.contextId)) {
    throw new Error('A workflow is already in progress');
  }

  const workflowId = crypto.randomUUID();
  activeWorkflows.set(params.contextId, workflowId);

  // Fire-and-forget: the actual work runs async, progress is reported via WS
  runWorkflow(params, workflowId).catch((err) => {
    log.error('Workflow unexpected error', {
      namespace: 'git-workflow',
      workflowId,
      error: String(err),
    });
  });

  return { workflowId };
}

async function runWorkflow(params: WorkflowParams, workflowId: string): Promise<void> {
  const { contextId, userId, cwd, action } = params;
  const title = TITLES[action];
  const isThread = !!params.threadId;

  // Discover hooks for commit actions
  let hooks: { label: string; command: string }[] = [];
  if (isCommitAction(action) && !params.noVerify) {
    const projectHooks = listHooks(cwd, 'pre-commit').filter((h) => h.enabled);
    hooks = projectHooks.map((h) => ({ label: h.label, command: h.command }));
  }

  let steps = buildSteps(params, hooks);

  const emit = (status: WSGitWorkflowProgressData['status']) =>
    emitProgress(userId, contextId, workflowId, status, title, action, steps);

  const setStep = (stepId: string, update: Partial<GitWorkflowProgressStep>) => {
    steps = markStep(steps, stepId, update);
    emit('step_update');
  };

  emit('started');

  try {
    // ── Unstage ──────────────────────────────────────────
    if (params.filesToUnstage && params.filesToUnstage.length > 0) {
      setStep('unstage', { status: 'running' });
      if (isThread && params.threadId) {
        await gitServiceUnstage(params.threadId, userId, cwd, params.filesToUnstage);
      } else {
        const result = await gitUnstageFiles(cwd, params.filesToUnstage);
        if (result.isErr()) throw new Error(result.error.message);
      }
      setStep('unstage', { status: 'completed' });
    }

    // ── Stage ────────────────────────────────────────────
    if (params.filesToStage && params.filesToStage.length > 0) {
      setStep('stage', { status: 'running' });
      if (isThread && params.threadId) {
        await gitServiceStage(params.threadId, userId, cwd, params.filesToStage);
      } else {
        const result = await gitStageFiles(cwd, params.filesToStage);
        if (result.isErr()) throw new Error(result.error.message);
      }
      setStep('stage', { status: 'completed' });
    }

    // ── Pre-commit hooks ─────────────────────────────────
    if (isCommitAction(action)) {
      setStep('hooks', { status: 'running' });

      if (hooks.length > 0) {
        for (let i = 0; i < hooks.length; i++) {
          // Mark current hook running, previous completed
          const subItems = hooks.map((h, idx) => ({
            label: h.label,
            status: (idx < i ? 'completed' : idx === i ? 'running' : 'pending') as
              | 'pending'
              | 'running'
              | 'completed'
              | 'failed',
          }));
          setStep('hooks', { status: 'running', subItems });

          const hookResult = await runHookCommand(cwd, hooks[i].command);

          if (!hookResult.success) {
            const failedSubItems = hooks.map((h, idx) => ({
              label: h.label,
              status: (idx < i ? 'completed' : idx === i ? 'failed' : 'pending') as
                | 'pending'
                | 'running'
                | 'completed'
                | 'failed',
              error: idx === i ? hookResult.output : undefined,
            }));
            setStep('hooks', {
              status: 'failed',
              subItems: failedSubItems,
              error: hookResult.output,
            });
            emit('failed');
            return;
          }
        }

        // All hooks passed
        const completedSubItems = hooks.map((h) => ({
          label: h.label,
          status: 'completed' as const,
        }));
        setStep('hooks', { status: 'completed', subItems: completedSubItems });
      } else {
        // No individual hooks — mark as completed
        setStep('hooks', { status: 'completed' });
      }

      // ── Commit ───────────────────────────────────────────
      setStep('commit', { status: 'running' });
      const isAmend = action === 'amend';
      // Skip built-in hooks since we already ran them individually
      const noVerify = hooks.length > 0;

      try {
        if (isThread && params.threadId) {
          await gitServiceCommit(params.threadId, userId, cwd, params.message!, isAmend, noVerify);
        } else {
          const identity = resolveIdentity(userId);
          const result = await gitCommit(cwd, params.message!, identity, isAmend, noVerify);
          if (result.isErr()) throw result.error;
          invalidateStatusCache(cwd);
        }
      } catch (e: any) {
        const errorMsg = e.stderr || e.message || 'Commit failed';
        setStep('commit', { status: 'failed', error: errorMsg });
        emit('failed');
        return;
      }
      setStep('commit', { status: 'completed' });
    }

    // ── Push ───────────────────────────────────────────────
    if (['commit-push', 'commit-pr', 'push', 'create-pr'].includes(action)) {
      setStep('push', { status: 'running' });
      try {
        if (isThread && params.threadId) {
          await gitServicePush(params.threadId, userId, cwd);
        } else {
          const identity = resolveIdentity(userId);
          const result = await gitPush(cwd, identity);
          if (result.isErr()) throw result.error;
          invalidateStatusCache(cwd);
        }
      } catch (e: any) {
        setStep('push', { status: 'failed', error: e.message || 'Push failed' });
        emit('failed');
        return;
      }
      setStep('push', { status: 'completed' });
    }

    // ── Create PR ──────────────────────────────────────────
    if (['commit-pr', 'create-pr'].includes(action)) {
      setStep('pr', { status: 'running' });
      try {
        if (!params.threadId) throw new Error('PR creation requires a thread');
        const prUrl = await gitServiceCreatePR({
          threadId: params.threadId,
          userId,
          cwd,
          title: params.prTitle || params.message || '',
          body: params.prBody || '',
        });
        setStep('pr', { status: 'completed', url: prUrl || undefined });
      } catch (e: any) {
        setStep('pr', { status: 'failed', error: e.message || 'PR creation failed' });
        emit('failed');
        return;
      }
    }

    // ── Merge ──────────────────────────────────────────────
    if (['commit-merge', 'merge'].includes(action)) {
      setStep('merge', { status: 'running' });
      try {
        if (!params.threadId) throw new Error('Merge requires a thread');
        await gitServiceMerge({
          threadId: params.threadId,
          userId,
          targetBranch: params.targetBranch,
          cleanup: params.cleanup,
        });
      } catch (e: any) {
        setStep('merge', { status: 'failed', error: e.message || 'Merge failed' });
        emit('failed');
        return;
      }
      setStep('merge', { status: 'completed' });
    }

    emit('completed');
  } catch (e: any) {
    log.error('Workflow step error', {
      namespace: 'git-workflow',
      workflowId,
      error: String(e),
    });
    emit('failed');
  } finally {
    activeWorkflows.delete(contextId);
  }
}
