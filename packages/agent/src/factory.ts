/**
 * The issue factory. On each tick it follows the pull requests of runs
 * waiting for CI, then admits ready issues:
 *
 *   queued → claiming → working → pr_open → waiting_ci ⇄ fixing → ready
 *
 * - A new run claims its issue and runs the `implement` step to a draft pull
 *   request.
 * - A run in `waiting_ci` is looked at every 3 minutes (no webhook): green CI
 *   marks the pull request ready for review (`ready`); a failing check or a
 *   conflict with the base runs the `fix` step, which resumes the same agent
 *   session (`fixing`, at most `MAX_FIX_ATTEMPTS` times, then `failed`).
 * - `queued`, `claiming`, `working` and `fixing` hold a concurrency slot;
 *   waiting for CI does not.
 *
 * Composed from ports, so the same code runs in production (`cli.ts`) and in
 * the whole-factory tests, which fake only GitHub (over HTTP), the agent and
 * the clock. Admission is the tracer bullet's (login, no active run, oldest
 * first, limits); assignee and blocker rules come with #284.
 */

import { randomUUID } from 'crypto';

import { holdsSlot, isActive, MAX_FIX_ATTEMPTS } from './domain/factory-run.js';
import type { FactoryLog } from './infrastructure/factory-log.js';
import type { Clock } from './ports/clock.js';
import type { IssueSource, ReadyIssue } from './ports/issue-source.js';
import type { CiState, PullRequestCi } from './ports/pull-request-ci.js';
import type { FactoryRun, RunStore } from './ports/run-store.js';
import type { WorkspaceProvider, WorkspaceRequest } from './ports/workspaces.js';
import { createRunRecorder } from './run-recorder.js';
import type { FactoryProject, FactorySettings } from './settings/schema.js';
import type { FixStepSpec } from './steps/fix.js';

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

export interface Factory {
  /** Follow CI and admit what can be admitted now; the work continues in the background. */
  tick(): Promise<void>;
  /** Resolves once every started piece of work has reached a state where it waits. */
  idle(): Promise<void>;
}

/** How often a run waiting for CI looks at its pull request. */
const CI_POLL_MS = 3 * 60 * 1000;
/** With no check reported this long after a push, the repository has no CI. */
const NO_CI_GRACE_MS = 15 * 60 * 1000;

const claimComment = (runId: string) =>
  `The issue factory is working on this issue (run \`${runId}\`). It will open a draft pull request that closes it.`;

const prNumberOf = (url: string | null) => Number(/\/pull\/(\d+)/.exec(url ?? '')?.[1] ?? NaN);
const failureOf = (outcome: { failure: string; reason: string }) =>
  `${outcome.failure} failure: ${outcome.reason}`;

export function createFactory(deps: FactoryDeps): Factory {
  const { settings, store, clock, log } = deps;
  const runs = createRunRecorder(deps);
  const inFlight = new Set<Promise<void>>();
  /** Runs with work in progress, so a tick never starts a second piece of work for one. */
  const busy = new Set<string>();
  const today = () => clock.now().toISOString().slice(0, 10);
  const later = () => new Date(clock.now().getTime() + CI_POLL_MS).toISOString();
  /** The fields of a run that (again) waits for CI. */
  const waitingForCi = (reason = 'waiting for CI') => ({ nextCheckAt: later(), reason });
  const slotsLeft = () =>
    settings.limits.concurrency - store.list().filter((r) => holdsSlot(r.state)).length;
  const fail = (run: FactoryRun, reason: string) => runs.transition(run, 'failed', { reason });

  function track(runId: string, work: () => Promise<unknown>): void {
    busy.add(runId);
    const running = work()
      .then(() => undefined)
      .catch((error) =>
        runs.abort(
          runId,
          `infra failure: stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        busy.delete(runId);
        inFlight.delete(running);
      });
    inFlight.add(running);
  }

  const workspaceRequest = (run: FactoryRun, project: FactoryProject): WorkspaceRequest => ({
    runId: run.id,
    runDir: runs.runDir(run.id),
    eventsPath: runs.eventsPath(run.id),
    repo: run.repo,
    projectPath: project.path,
    base: run.base!,
    branch: run.branch!,
  });

  /** From claiming the issue to the pull request of its `implement` step. */
  async function implementIssue(project: FactoryProject, queued: FactoryRun): Promise<FactoryRun> {
    let run = runs.transition(queued, 'claiming');
    const claimed = await deps.issues.claim(run.repo, run.issueNumber, {
      login: settings.github.login,
      readyLabel: settings.labels.ready,
      inProgressLabel: settings.labels.in_progress,
      comment: claimComment(run.id),
    });
    if (claimed.isErr()) return fail(run, `could not claim the issue: ${claimed.error.message}`);

    run = runs.transition(run, 'working');
    const base = project.base ?? (await deps.issues.defaultBranch(run.repo).unwrapOr(null));
    if (!base) return fail(run, 'could not read the repository default branch');
    const trusted = await deps.issues.readTrusted(run.repo, run.issueNumber, settings.github.login);
    if (trusted.isErr()) return fail(run, `could not read the issue: ${trusted.error.message}`);
    run = runs.update(run, {
      base,
      branch: `factory/issue-${run.issueNumber}-${run.id.slice(-8)}`,
      issueTitle: trusted.value.title,
    });

    const workspace = await deps.workspaces.prepare(workspaceRequest(run, project));
    if (workspace.isErr()) return fail(run, `could not prepare the workspace: ${workspace.error}`);
    try {
      const outcome = await workspace.value.implement({
        runId: run.id,
        issue: trusted.value,
        base,
        branch: run.branch!,
        checkCommand: project.check,
        author: settings.github.author,
        model: settings.model,
      });
      if (outcome.kind === 'failed') return fail(run, failureOf(outcome));
      if (outcome.kind !== 'pr_opened') return fail(run, 'infra failure: no pull request');
      run = runs.transition(run, 'pr_open', {
        prUrl: outcome.prUrl,
        sessionId: outcome.sessionId,
        pushedAt: clock.now().toISOString(),
      });
      return runs.transition(run, 'waiting_ci', waitingForCi());
    } finally {
      await workspace.value.release();
    }
  }

  /** A `fix` step for a failing check or a conflict, in the run's own checkout. */
  async function fixRun(
    project: FactoryProject,
    fixing: FactoryRun,
    problem: FixStepSpec['problem'],
  ): Promise<FactoryRun> {
    if (!fixing.sessionId) return fail(fixing, 'infra failure: no agent session to resume');
    const workspace = await deps.workspaces.reopen(workspaceRequest(fixing, project));
    if (workspace.isErr())
      return fail(fixing, `could not reopen the workspace: ${workspace.error}`);
    try {
      const outcome = await workspace.value.fix({
        runId: fixing.id,
        sessionId: fixing.sessionId,
        issue: {
          number: fixing.issueNumber,
          title: fixing.issueTitle ?? `Issue #${fixing.issueNumber}`,
        },
        prUrl: fixing.prUrl!,
        base: fixing.base!,
        branch: fixing.branch!,
        checkCommand: project.check,
        author: settings.github.author,
        model: settings.model,
        problem,
      });
      // An agent that could not fix it has used up an attempt; CI is looked at again.
      if (outcome.kind === 'failed' && outcome.failure === 'agent') {
        return runs.transition(fixing, 'waiting_ci', waitingForCi(`last fix: ${outcome.reason}`));
      }
      if (outcome.kind === 'failed') return fail(fixing, failureOf(outcome));
      return runs.transition(fixing, 'waiting_ci', {
        ...waitingForCi(),
        sessionId: outcome.sessionId ?? fixing.sessionId,
        pushedAt: clock.now().toISOString(),
      });
    } finally {
      await workspace.value.release();
    }
  }

  /** What a red pull request gets: a fix if attempts and a slot are left. */
  function onRed(
    project: FactoryProject,
    run: FactoryRun,
    ci: Extract<CiState, { kind: 'failing' | 'conflict' }>,
  ) {
    const attempts = run.fixAttempts ?? 0;
    if (attempts >= MAX_FIX_ATTEMPTS) {
      return fail(run, `agent failure: CI did not pass after ${MAX_FIX_ATTEMPTS} fix attempts`);
    }
    // Checked and taken without awaiting, so two follow-ups cannot take one slot.
    if (slotsLeft() <= 0)
      return runs.update(run, waitingForCi('waiting for a free slot to fix CI'));
    const [problem, reason]: [FixStepSpec['problem'], string] =
      ci.kind === 'conflict'
        ? [{ kind: 'conflict' }, 'fixing a conflict with the base']
        : [{ kind: 'checks', checks: ci.checks }, 'fixing failing checks'];
    const fixing = runs.transition(run, 'fixing', { fixAttempts: attempts + 1, reason });
    return fixRun(project, fixing, problem);
  }

  /** Take the pull request out of draft; the run is `ready`. */
  async function markReady(run: FactoryRun, number: number, reason: string | null) {
    const marked = await deps.pullRequests.markReady(run.repo, number);
    if (marked.isOk()) return runs.transition(run, 'ready', { reason, nextCheckAt: undefined });
    log.warn('Could not mark a pull request ready', { run: run.id, error: marked.error.message });
    return runs.update(run, { nextCheckAt: later() });
  }

  /** No check reported: CI may not have started, or the repository has none. */
  function onNoChecks(run: FactoryRun, number: number) {
    const pushedAt = Date.parse(run.pushedAt ?? run.updatedAt);
    if (clock.now().getTime() - pushedAt < NO_CI_GRACE_MS) {
      return runs.update(run, waitingForCi('waiting for CI to report a check'));
    }
    return markReady(run, number, 'no CI reported any check; marked ready without CI');
  }

  /** One look at a waiting run's pull request. */
  async function followCi(project: FactoryProject, run: FactoryRun): Promise<FactoryRun> {
    const number = prNumberOf(run.prUrl);
    const ci = await deps.pullRequests.ciState(run.repo, number);
    if (ci.isErr()) {
      log.warn('Could not read the CI of a pull request', { run: run.id, error: ci.error.message });
      return runs.update(run, { nextCheckAt: later() });
    }
    switch (ci.value.kind) {
      case 'pending':
        return runs.update(run, waitingForCi());
      case 'none':
        return onNoChecks(run, number);
      case 'green':
        return markReady(run, number, null);
      default:
        return onRed(project, run, ci.value);
    }
  }

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

  async function admit(project: FactoryProject): Promise<void> {
    const ready = await deps.issues.listReady(project.repo, settings.labels.ready);
    if (ready.isErr()) {
      log.warn('Could not list ready issues', { repo: project.repo, error: ready.error.message });
      return;
    }
    const login = settings.github.login.toLowerCase();
    const active = (n: number) =>
      store.list().some((r) => r.repo === project.repo && r.issueNumber === n && isActive(r.state));
    for (const issue of ready.value) {
      if (slotsLeft() <= 0 || settings.limits.daily - store.startedOn(today()) <= 0) return;
      if (issue.author.toLowerCase() !== login || active(issue.number)) continue;
      startRun(project, issue);
    }
  }

  /** Runs waiting for CI whose next look is due. */
  function followDueRuns(projects: FactoryProject[]): void {
    const now = clock.now().getTime();
    for (const run of store.list()) {
      const project = projects.find((p) => p.repo === run.repo);
      const due = !run.nextCheckAt || Date.parse(run.nextCheckAt) <= now;
      if (run.state !== 'waiting_ci' || !project || busy.has(run.id) || !due) continue;
      track(run.id, () => followCi(project, run));
    }
  }

  return {
    async tick() {
      // Sandbox workspaces come with #289; until then only worktree projects run.
      const projects = settings.projects.filter((p) => p.workspace === 'worktree');
      followDueRuns(projects);
      for (const project of projects) await admit(project);
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
      await runs.flush();
    },
  };
}
