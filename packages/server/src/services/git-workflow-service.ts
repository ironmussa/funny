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
import { getActionPipeline, deriveSteps, type GitPipelineContext } from './git-pipelines.js';
import { getPipelineForProject } from './pipeline-orchestrator.js';
import { listHooks } from './project-hooks-service.js';
import { emitWorkflowEvent } from './workflow-event-helpers.js';
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

  // Create bound helpers for progress emission (close over `steps`)
  let steps: GitWorkflowProgressStep[] = [];

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

  // Select the right pipeline for this action
  const pipeline = getActionPipeline(params.action);

  // Derive steps from the pipeline definition by walking nodes and evaluating guards
  steps = deriveSteps(pipeline, initialCtx);
  initialCtx.steps = steps;

  emit('started');

  // Emit workflow:started thread event (only for thread-scoped operations)
  if (params.threadId) {
    emitWorkflowEvent(params.userId, params.threadId, 'workflow:started', {
      workflowId,
      action: params.action,
      title: TITLES[params.action],
    });
  }

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
