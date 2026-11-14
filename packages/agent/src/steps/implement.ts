/**
 * The `implement` step of a factory run.
 *
 * Runs the `factory-issue` workflow (the repository's override, else the
 * built-in one; see `factory-workflow.ts`) in the workspace (`cwd`, already
 * on the run's branch) with the pipelines engine and a workspace-local action
 * provider: the agent implements the issue, the checks run with in-place fixes,
 * and the result is committed with the configured author, pushed, and opened as
 * a draft pull request against the base that closes the issue.
 *
 * It prints `pr_url=…` and `session_id=…`, appends its events to the run's
 * event file, and writes the outcome to the exit marker, which is how the
 * orchestrator learns how the step ended.
 */

import type { IAgentProcessFactory } from '@funny/core/agents';
import { nullReporter, runPipeline, type StepProgressData } from '@funny/pipelines';
import type { YamlPipelineContext } from '@funny/workflows/compiler';
import { z } from 'zod';

import { WorkspaceActionProvider } from '../adapters/workspace-action-provider.js';
import { buildPullRequestBody } from '../domain/pull-request-body.js';
import type { StepOutcome } from '../domain/step-outcome.js';
import type { PullRequestOpener } from '../ports/pull-requests.js';
import { FACTORY_ISSUE_WORKFLOW, loadFactoryWorkflow } from './factory-workflow.js';
import { stepIo, stepSpecFields } from './step-io.js';

/** How `implement` ends: a pull request, or a failure (it never just pushes). */
type ImplementOutcome = Exclude<StepOutcome, { kind: 'pushed' }>;

export const implementStepSpecSchema = z.object({
  ...stepSpecFields,
  /** Trusted text only: the configured login's issue body and comments. */
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string(),
  }),
});

export type ImplementStepSpec = z.infer<typeof implementStepSpecSchema>;

export interface ImplementStepDeps {
  /** The workspace: a checkout of the repository on `spec.branch`. */
  cwd: string;
  agents: IAgentProcessFactory;
  pullRequests: PullRequestOpener;
  /** Writes one line to the step's standard output. */
  print: (line: string) => void;
  now?: () => Date;
}

export async function runImplementStep(
  spec: ImplementStepSpec,
  deps: ImplementStepDeps,
): Promise<ImplementOutcome> {
  const now = deps.now ?? (() => new Date());
  const { report, finish } = stepIo(spec, now);
  const workflowEvent = { run_id: spec.runId, workflow_name: FACTORY_ISSUE_WORKFLOW };

  const provider = new WorkspaceActionProvider({
    cwd: deps.cwd,
    branch: spec.branch,
    base: spec.base,
    author: spec.author,
    model: spec.model,
    agents: deps.agents,
    pullRequests: deps.pullRequests,
    onAgentMessage: (message) => report('factory.cli_message', { cli_message: message }),
  });

  report('factory.started', {
    step: 'implement',
    issue_number: spec.issue.number,
    branch: spec.branch,
    base: spec.base,
  });

  report('workflow.started', workflowEvent);

  let outcome: ImplementOutcome;
  try {
    outcome = await runWorkflow(
      spec,
      deps.cwd,
      provider,
      (stepId, progress) =>
        report(`workflow.step.${progress.status}`, {
          ...workflowEvent,
          step_name: stepId,
          ...(progress.error ? { error: progress.error } : {}),
        }),
      (source, path) => report('factory.workflow_selected', { source, ...(path ? { path } : {}) }),
    );
  } catch (err) {
    // Whatever went wrong, the step still ends with an outcome and a marker.
    const reason = err instanceof Error ? err.message : String(err);
    outcome = { kind: 'failed', failure: 'infra', reason, sessionId: provider.sessionId };
  }

  if (outcome.kind === 'pr_opened') {
    deps.print(`pr_url=${outcome.prUrl}`);
    report('workflow.completed', workflowEvent);
  } else {
    report('workflow.failed', { ...workflowEvent, error: outcome.reason });
  }
  return finish(outcome, deps.print, outcome.kind === 'pr_opened' ? { pr_url: outcome.prUrl } : {});
}

async function runWorkflow(
  spec: ImplementStepSpec,
  cwd: string,
  provider: WorkspaceActionProvider,
  onStepProgress: (stepId: string, progress: StepProgressData) => void,
  onWorkflowChosen: (source: 'repository' | 'built-in', path?: string) => void,
): Promise<ImplementOutcome> {
  const workflow = await loadFactoryWorkflow(cwd, spec.base);
  if (!workflow.ok) return { kind: 'failed', failure: workflow.failure, reason: workflow.reason };
  onWorkflowChosen(workflow.source, workflow.path);

  const ctx: YamlPipelineContext = {
    provider,
    progress: { ...nullReporter, onStepProgress },
    cwd,
    inputs: {
      issue_number: String(spec.issue.number),
      issue_title: spec.issue.title,
      issue_body: spec.issue.body,
      base: spec.base,
      branch: spec.branch,
      check_command: spec.checkCommand ?? '',
      pr_body: buildPullRequestBody({
        issueNumber: spec.issue.number,
        checkCommand: spec.checkCommand,
      }),
    },
    outputs: {},
  };

  const result = await runPipeline(workflow.pipeline, ctx);
  const sessionId = provider.sessionId;

  if (result.outcome === 'completed' && provider.prUrl) {
    return { kind: 'pr_opened', prUrl: provider.prUrl, sessionId };
  }
  return {
    kind: 'failed',
    failure: provider.lastFailure ?? 'infra',
    reason: result.error ?? `workflow ${result.outcome} without opening a pull request`,
    sessionId,
  };
}
