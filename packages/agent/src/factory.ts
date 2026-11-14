/**
 * The issue factory. On each tick it follows the pull requests of its runs,
 * retries what is due, then admits ready issues:
 *
 *   queued → claiming → working → pr_open → waiting_ci ⇄ fixing → ready | merging → merged
 *
 * - `factory/implement-run.ts`: a new run claims its issue and runs the
 *   `implement` step to a draft pull request.
 * - `factory/pull-request.ts`: a run waiting for CI looks at its pull request
 *   every 3 minutes; green marks it ready, red runs a `fix`.
 * - `factory/merge.ts`: with auto-merge on, GitHub merges a green pull request
 *   (`merging`); once merged, the factory run's workspace and branch are removed.
 * - `factory/failures.ts`: infrastructure failures are retried, agent
 *   failures hand the issue back.
 * - `queued`, `claiming`, `working` and `fixing` hold a concurrency slot;
 *   waiting (for CI, to merge) does not.
 *
 * Composed from ports, so the same code runs in production (`cli.ts`) and in
 * the whole-factory tests, which fake only GitHub (over HTTP), the agent and
 * the clock. Admission is the tracer bullet's (login, no active run, oldest
 * first, limits); assignee and blocker rules come with #284.
 */

import { randomUUID } from 'crypto';

import { needsHandBack, type RunState } from './domain/factory-run.js';
import { createAdmission } from './factory/admission.js';
import { createFactoryContext, type FactoryDeps } from './factory/context.js';
import { createFailures } from './factory/failures.js';
import { createImplementRun } from './factory/implement-run.js';
import { createPullRequestFollowUp } from './factory/pull-request.js';
import { createReconciliation } from './factory/reconcile.js';
import type { ReadyIssue } from './ports/issue-source.js';
import type { FactoryRun } from './ports/run-store.js';
import type { FactoryProject } from './settings/schema.js';

export type { FactoryDeps } from './factory/context.js';

/** States in which a run waits on its pull request and looks at it now and then. */
const FOLLOWED_STATES = new Set<RunState>(['waiting_ci', 'merging', 'ready']);
/** States in which a run is always being worked on by this process, unless it was left behind. */
const ORPHAN_STATES = new Set<RunState>(['claiming', 'working', 'fixing', 'pr_open']);

export interface Factory {
  /**
   * Bring the state in line with GitHub and the workspaces after a (possibly
   * abrupt) stop; call it once, before the first tick.
   */
  reconcile(): Promise<void>;
  /** Follow pull requests and admit what can be admitted now; the work continues in the background. */
  tick(): Promise<void>;
  /** Resolves once every started piece of work has reached a state where it waits. */
  idle(): Promise<void>;
}

export function createFactory(deps: FactoryDeps): Factory {
  const ctx = createFactoryContext(deps);
  const { settings, store, clock, runs } = ctx;
  const failures = createFailures(ctx);
  const implementIssue = createImplementRun(ctx, failures);
  const followPullRequest = createPullRequestFollowUp(ctx, failures);
  const reconciliation = createReconciliation(ctx, failures);
  let reconciled = false;
  /** Sandbox workspaces come with #289; until then only worktree projects run. */
  const watched = () => settings.projects.filter((p) => p.workspace === 'worktree');
  const inFlight = new Set<Promise<void>>();
  /** Runs with work in progress, so a tick never starts a second piece of work for one. */
  const busy = new Set<string>();
  const today = () => clock.now().toISOString().slice(0, 10);

  function track(runId: string, work: () => Promise<unknown>): void {
    busy.add(runId);
    const running = work()
      .then(() => undefined)
      .catch(async (error) => {
        const reason = `stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
        const aborted = runs.abort(runId, reason);
        if (aborted) await failures.handBack(aborted);
      })
      .finally(() => {
        busy.delete(runId);
        inFlight.delete(running);
      });
    inFlight.add(running);
  }

  const admit = createAdmission(ctx, (project, issue) => startRun(project, issue), {
    timeoutMs: deps.admissionTimeoutMs,
  });

  function startRun(project: FactoryProject, issue: ReadyIssue): void {
    const id = `r-${issue.number}-${randomUUID().slice(0, 8)}`;
    const now = clock.now().toISOString();
    const queued: FactoryRun = {
      id,
      repo: project.repo,
      issueNumber: issue.number,
      state: 'queued',
      prUrl: null,
      reason: null,
      createdAt: now,
      updatedAt: now,
    };
    runs.create(queued);
    store.recordStart(today());
    track(id, () => implementIssue(project, queued));
  }

  /** Runs of a watched project with no work in progress, with their project. */
  function* idleRuns(projects: FactoryProject[]): Generator<[FactoryRun, FactoryProject]> {
    for (const run of store.list()) {
      const project = projects.find((p) => p.repo === run.repo);
      if (project && !busy.has(run.id)) yield [run, project];
    }
  }

  /** Failed runs whose issue could not be handed back yet, watched project or not. */
  function retryHandBacks(): void {
    for (const run of store.list()) {
      if (needsHandBack(run) && !busy.has(run.id)) track(run.id, () => failures.handBack(run));
    }
  }

  /** Runs waiting to retry an infrastructure failure whose time has come. */
  function retryDueRuns(projects: FactoryProject[]): void {
    for (const [run, project] of idleRuns(projects)) {
      if (run.state !== 'queued' || !run.notBefore || !ctx.isDue(run.notBefore)) continue;
      if (ctx.slotsLeft() <= 0) {
        runs.update(run, { reason: 'retry due; waiting for a free slot' });
        continue;
      }
      const retrying = runs.update(run, { notBefore: undefined });
      track(run.id, () => implementIssue(project, retrying));
    }
  }

  /**
   * Runs in a working state that nothing in this process works on: left by a
   * previous process, or by a reconciliation that could not ask GitHub.
   */
  function reconcileOrphans(projects: FactoryProject[]): void {
    for (const [run, project] of idleRuns(projects)) {
      const orphan =
        ORPHAN_STATES.has(run.state as RunState) || (run.state === 'queued' && !run.notBefore);
      if (orphan) track(run.id, () => reconciliation.reconcileRun(project, run));
    }
  }

  /** Runs waiting on their pull request whose next look is due. */
  function followDueRuns(projects: FactoryProject[]): void {
    for (const [run, project] of idleRuns(projects)) {
      if (FOLLOWED_STATES.has(run.state as RunState) && ctx.isDue(run.nextCheckAt)) {
        track(run.id, () => followPullRequest(project, run));
      }
    }
  }

  return {
    async reconcile() {
      if (reconciled) return;
      reconciled = true;
      await reconciliation.reconcileAll(watched());
      await runs.flush();
    },
    async tick() {
      const projects = watched();
      reconcileOrphans(projects);
      followDueRuns(projects);
      retryDueRuns(projects);
      retryHandBacks();
      await admit(projects);
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
      await runs.flush();
    },
  };
}
