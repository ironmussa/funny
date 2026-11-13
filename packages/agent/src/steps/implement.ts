/**
 * The `implement` step of a factory run.
 *
 * Runs the built-in `factory-issue` workflow in the workspace (`cwd`, already
 * on the run's branch) with the pipelines engine and a workspace-local action
 * provider: the agent implements the issue, the checks run with in-place fixes,
 * and the result is committed with the configured author, pushed, and opened as
 * a draft pull request against the base that closes the issue.
 *
 * It prints `pr_url=…` and `session_id=…`, appends its events to the run's
 * event file, and writes the outcome to the exit marker, which is how the
 * orchestrator learns how the step ended.
 */

import { mkdir, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';

import type { IAgentProcessFactory } from '@funny/core/agents';
import { nullReporter, runPipeline, type StepProgressData } from '@funny/pipelines';
import { loadWorkflowCatalog } from '@funny/workflows';
import { compileYamlPipeline, type YamlPipelineContext } from '@funny/workflows/compiler';
import { z } from 'zod';

import { JsonlRunReporter } from '../adapters/jsonl-run-reporter.js';
import { WorkspaceActionProvider } from '../adapters/workspace-action-provider.js';
import { buildPullRequestBody } from '../domain/pull-request-body.js';
import type { StepOutcome } from '../domain/step-outcome.js';
import type { PullRequestOpener } from '../ports/pull-requests.js';
import type { RunReporter } from '../ports/run-reporter.js';

const FACTORY_ISSUE_WORKFLOW = 'factory-issue';

export const implementStepSpecSchema = z.object({
  runId: z.string().min(1),
  /** Trusted text only: the configured login's issue body and comments. */
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string(),
  }),
  base: z.string().min(1),
  branch: z.string().min(1),
  checkCommand: z.string().optional(),
  author: z.object({ name: z.string().min(1), email: z.string().min(1) }),
  model: z.string().min(1),
  eventsPath: z.string().min(1),
  exitMarkerPath: z.string().min(1),
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
): Promise<StepOutcome> {
  const now = deps.now ?? (() => new Date());
  const reporter: RunReporter = new JsonlRunReporter(spec.eventsPath);
  const reports: Promise<void>[] = [];
  const report = (event_type: string, data: Record<string, unknown>) => {
    reports.push(
      reporter.report({
        event_type,
        request_id: spec.runId,
        thread_id: spec.runId,
        timestamp: now().toISOString(),
        data,
      }),
    );
  };
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

  let outcome: StepOutcome;
  try {
    outcome = await runWorkflow(spec, deps.cwd, provider, (stepId, progress) =>
      report(`workflow.step.${progress.status}`, {
        ...workflowEvent,
        step_name: stepId,
        ...(progress.error ? { error: progress.error } : {}),
      }),
    );
  } catch (err) {
    // Whatever went wrong, the step still ends with an outcome and a marker.
    const reason = err instanceof Error ? err.message : String(err);
    outcome = { kind: 'failed', failure: 'infra', reason, sessionId: provider.sessionId };
  }

  if (outcome.kind === 'pr_opened') {
    deps.print(`pr_url=${outcome.prUrl}`);
    report('workflow.completed', workflowEvent);
    report('factory.completed', { pr_url: outcome.prUrl, session_id: outcome.sessionId });
  } else {
    report('workflow.failed', { ...workflowEvent, error: outcome.reason });
    report('factory.failed', {
      error: outcome.reason,
      failure_kind: outcome.failure,
      session_id: outcome.sessionId,
    });
  }
  if (outcome.sessionId) deps.print(`session_id=${outcome.sessionId}`);

  // A broken event file loses the run's history but must not hide its outcome.
  const failedReports = (await Promise.allSettled(reports)).filter((r) => r.status === 'rejected');
  await writeExitMarker(spec.exitMarkerPath, {
    ...outcome,
    ...(failedReports.length > 0
      ? { eventFileError: String((failedReports[0] as PromiseRejectedResult).reason) }
      : {}),
    finishedAt: now().toISOString(),
  });
  return outcome;
}

async function runWorkflow(
  spec: ImplementStepSpec,
  cwd: string,
  provider: WorkspaceActionProvider,
  onStepProgress: (stepId: string, progress: StepProgressData) => void,
): Promise<StepOutcome> {
  const { workflows, warnings } = await loadWorkflowCatalog();
  const entry = workflows.get(FACTORY_ISSUE_WORKFLOW);
  if (!entry) {
    const reason = `built-in workflow "${FACTORY_ISSUE_WORKFLOW}" not found: ${warnings.join('; ')}`;
    return { kind: 'failed', failure: 'infra', reason };
  }

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

  const result = await runPipeline(compileYamlPipeline(entry.workflow), ctx);
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

/** Written last and atomically: its presence means the step has ended. */
async function writeExitMarker(path: string, marker: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');
  await rename(temp, path);
}
