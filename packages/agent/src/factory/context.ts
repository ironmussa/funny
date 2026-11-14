/**
 * What the parts of the factory share: its dependencies, the run recorder,
 * time helpers, the concurrency slots and the workspace of a run.
 */

import { holdsSlot } from '../domain/factory-run.js';
import type { FactoryLog } from '../infrastructure/factory-log.js';
import type { Clock } from '../ports/clock.js';
import type { IssueSource } from '../ports/issue-source.js';
import type { PullRequestCi } from '../ports/pull-request-ci.js';
import type { FactoryRun, RunStore } from '../ports/run-store.js';
import type { WorkspaceProvider, WorkspaceRequest } from '../ports/workspaces.js';
import { createRunRecorder, type RunRecorder } from '../run-recorder.js';
import type { FactoryProject, FactorySettings } from '../settings/schema.js';

export interface FactoryDeps {
  settings: FactorySettings;
  issues: IssueSource;
  pullRequests: PullRequestCi;
  workspaces: WorkspaceProvider;
  store: RunStore;
  clock: Clock;
  log: FactoryLog;
  /** The factory home; runs live in `<home>/runs/<runId>/`. */
  home: string;
}

/** How often a run waiting on its pull request looks at it. */
const POLL_MS = 3 * 60 * 1000;
/** How often a run marked ready looks whether a person merged its pull request. */
export const READY_POLL_MS = 30 * 60 * 1000;

export interface FactoryContext extends FactoryDeps {
  runs: RunRecorder;
  /** The next look at a pull request (ISO 8601), in 3 minutes unless `ms` says otherwise. */
  later(ms?: number): string;
  /** The fields of a run that (again) waits for CI. */
  waitingForCi(reason?: string): { nextCheckAt: string; reason: string };
  isDue(at: string | undefined): boolean;
  slotsLeft(): number;
  workspaceRequest(run: FactoryRun, project: FactoryProject): WorkspaceRequest;
}

export function createFactoryContext(deps: FactoryDeps): FactoryContext {
  const { clock, store, settings } = deps;
  const runs = createRunRecorder(deps);
  const later = (ms = POLL_MS) => new Date(clock.now().getTime() + ms).toISOString();
  return {
    ...deps,
    runs,
    later,
    waitingForCi: (reason = 'waiting for CI') => ({ nextCheckAt: later(), reason }),
    isDue: (at) => !at || Date.parse(at) <= clock.now().getTime(),
    slotsLeft: () => settings.limits.concurrency - store.list().filter(holdsSlot).length,
    workspaceRequest: (run, project) => ({
      runId: run.id,
      runDir: runs.runDir(run.id),
      eventsPath: runs.eventsPath(run.id),
      repo: run.repo,
      projectPath: project.path,
      base: run.base!,
      branch: run.branch!,
    }),
  };
}

export const prNumberOf = (url: string | null) =>
  Number(/\/pull\/(\d+)/.exec(url ?? '')?.[1] ?? NaN);
