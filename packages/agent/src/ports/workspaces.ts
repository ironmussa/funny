/**
 * Where a factory run works: a git worktree of the project (this change) or
 * a sandbox (later). Each workspace has the run's own GitHub token, renewed
 * while a step runs, and runs the step runner with the protocol of
 * `bin/step.ts` (spec file in, event file and exit marker out).
 */

import type { ResultAsync } from 'neverthrow';

import type { StepOutcome } from '../domain/step-outcome.js';
import type { ImplementStepSpec } from '../steps/implement.js';

/** How the step runner is started: a child process in production. Resolves to its exit code. */
export type StepLauncher = (launch: {
  specPath: string;
  /** The workspace's checkout. */
  cwd: string;
  /** The whole environment of the step: nothing else is inherited. */
  env: Record<string, string>;
}) => Promise<number>;

export interface RunWorkspace {
  cwd: string;
  /** Run the `implement` step; resolves to how it ended, as its exit marker says. */
  implement(spec: Omit<ImplementStepSpec, 'eventsPath' | 'exitMarkerPath'>): Promise<StepOutcome>;
  /** Stop renewing the run's token. The checkout stays for later steps. */
  release(): Promise<void>;
}

export interface WorkspaceRequest {
  runId: string;
  /** The run's directory, owned by the workspace: checkout, credentials, step files. */
  runDir: string;
  /** Its event file, shared with the orchestrator's own events for the run. */
  eventsPath: string;
  /** `owner/name`. */
  repo: string;
  /** The project's local checkout. */
  projectPath: string;
  base: string;
  branch: string;
}

export interface WorkspaceProvider {
  prepare(request: WorkspaceRequest): ResultAsync<RunWorkspace, string>;
}
