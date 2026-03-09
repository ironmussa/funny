/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: git:workflow_progress (via WSBroker)
 * @domain depends: GitPipelines, PipelineEngine, WSBroker
 *
 * Thin executor that selects the right pipeline for a git workflow action
 * and runs it. All node logic lives in git-pipelines.ts.
 */

import type {
  GitWorkflowAction,
  GitWorkflowProgressStep,
  WSGitWorkflowProgressData,
} from '@funny/shared';
import { runPipeline, type PipelineRunOptions } from '@funny/shared/pipeline-engine';

import { log } from '../lib/logger.js';
import { getActionPipeline, type GitPipelineContext } from './git-pipelines.js';
import { getPipelineForProject } from './pipeline-orchestrator.js';
import { listHooks } from './project-hooks-service.js';
import { saveThreadEvent } from './thread-event-service.js';
import { wsBroker } from './ws-broker.js';

// ── Thread event helpers ────────────────────────────────────────

function broadcastThreadEvent(
  userId: string,
  threadId: string,
  type: string,
  data: Record<string, unknown>,
) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  wsBroker.emitToUser(userId, {
    type: 'thread:event',
    threadId,
    data: {
      event: { id, threadId, type, data: JSON.stringify(data), createdAt },
    },
  });
}

async function emitWorkflowEvent(
  userId: string,
  threadId: string,
  type: string,
  data: Record<string, unknown>,
) {
  await saveThreadEvent(threadId, type, data);
  broadcastThreadEvent(userId, threadId, type, data);
}

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

const activeWorkflows = new Map<string, AbortController>();

export function isWorkflowActive(contextId: string): boolean {
  return activeWorkflows.has(contextId);
}

// ── Progress helpers ─────────────────────────────────────────

function emitProgress(
  userId: string,
  contextId: string,
  workflowId: string,
  status: WSGitWorkflowProgressData['status'],
  action: GitWorkflowAction,
  steps: GitWorkflowProgressStep[],
) {
  const title = TITLES[action];
  wsBroker.emitToUser(userId, {
    type: 'git:workflow_progress',
    threadId: contextId,
    data: { workflowId, status, title, action, steps },
  });
}

function markStep(
  steps: GitWorkflowProgressStep[],
  stepId: string,
  update: Partial<GitWorkflowProgressStep>,
): GitWorkflowProgressStep[] {
  return steps.map((s) => (s.id === stepId ? { ...s, ...update } : s));
}

// ── Constants ────────────────────────────────────────────────

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

function isCommitAction(action: GitWorkflowAction): boolean {
  return ['commit', 'amend', 'commit-push', 'commit-pr', 'commit-merge'].includes(action);
}

// ── Step builder ─────────────────────────────────────────────

function buildSteps(
  params: WorkflowParams,
  hooks: { label: string; command: string }[],
  pipelineEnabled: boolean,
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

    // Add review-fix steps if pipeline is enabled
    if (pipelineEnabled && params.threadId && params.projectId) {
      steps.push({ id: 'review', label: 'Reviewing code', status: 'pending' });
      steps.push({ id: 'fix', label: 'Fixing issues', status: 'pending' });
    }
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
  const abortController = new AbortController();
  activeWorkflows.set(params.contextId, abortController);

  // Discover hooks for commit actions
  let hooks: { label: string; command: string }[] = [];
  if (isCommitAction(params.action) && !params.noVerify) {
    const projectHooks = listHooks(params.cwd, 'pre-commit').filter((h) => h.enabled);
    hooks = projectHooks.map((h) => ({ label: h.label, command: h.command }));
  }

  // Check if pipeline is enabled for this project
  const pipelineConfig = params.projectId ? getPipelineForProject(params.projectId) : null;
  const pipelineEnabled = !!pipelineConfig;

  let steps = buildSteps(params, hooks, pipelineEnabled);

  // Create bound helpers for progress emission
  const emit = (status: WSGitWorkflowProgressData['status']) =>
    emitProgress(params.userId, params.contextId, workflowId, status, params.action, steps);

  const setStep = (stepId: string, update: Partial<GitWorkflowProgressStep>) => {
    steps = markStep(steps, stepId, update);
    emit('step_update');
  };

  // Build the unified context
  const initialCtx: GitPipelineContext = {
    contextId: params.contextId,
    threadId: params.threadId,
    projectId: params.projectId,
    userId: params.userId,
    cwd: params.cwd,
    action: params.action,
    message: params.message,
    filesToStage: params.filesToStage,
    filesToUnstage: params.filesToUnstage,
    amend: params.amend,
    noVerify: params.noVerify,
    prTitle: params.prTitle,
    prBody: params.prBody,
    targetBranch: params.targetBranch,
    cleanup: params.cleanup,
    hooks,
    workflowId,
    steps,
    emit,
    setStep,
    // Pipeline config
    pipelineEnabled,
    precommitFixEnabled: pipelineConfig?.precommitFixEnabled ?? false,
    precommitFixModel: pipelineConfig?.precommitFixModel ?? 'sonnet',
    precommitFixMaxIterations: pipelineConfig?.precommitFixMaxIterations ?? 3,
    reviewModel: pipelineConfig?.reviewModel ?? 'sonnet',
    fixModel: pipelineConfig?.fixModel ?? 'sonnet',
    maxReviewIterations: pipelineConfig?.maxIterations ?? 10,
    // Review-fix tracking (initialized empty)
    commitSha: null,
    iteration: 1,
    reviewerThreadId: null,
    verdict: null,
    findings: null,
    correctorThreadId: null,
    patchDiff: null,
    noChanges: false,
    prUrl: undefined,
  };

  emit('started');

  // Emit workflow:started thread event (only for thread-scoped operations)
  if (params.threadId) {
    emitWorkflowEvent(params.userId, params.threadId, 'workflow:started', {
      workflowId,
      action: params.action,
      title: TITLES[params.action],
    });
  }

  // Select the right pipeline for this action
  const pipeline = getActionPipeline(params.action);

  const pipelineOpts: PipelineRunOptions<GitPipelineContext> = {
    signal: abortController.signal,
    maxIterations: pipelineConfig?.maxIterations,
  };

  runPipeline(pipeline, initialCtx, pipelineOpts)
    .then((result) => {
      if (result.outcome === 'completed') {
        emit('completed');
        if (params.threadId) {
          emitWorkflowEvent(params.userId, params.threadId, 'workflow:completed', {
            workflowId,
            action: params.action,
            status: 'completed',
          });
        }
      } else {
        emit('failed');
        if (params.threadId) {
          emitWorkflowEvent(params.userId, params.threadId, 'workflow:completed', {
            workflowId,
            action: params.action,
            status: 'failed',
          });
        }
      }
    })
    .catch((err) => {
      log.error('Workflow unexpected error', {
        namespace: 'git-workflow',
        workflowId,
        error: String(err),
      });
      emit('failed');
      if (params.threadId) {
        emitWorkflowEvent(params.userId, params.threadId, 'workflow:completed', {
          workflowId,
          action: params.action,
          status: 'failed',
          error: String(err),
        });
      }
    })
    .finally(() => {
      activeWorkflows.delete(params.contextId);
    });

  return { workflowId };
}
