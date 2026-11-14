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

import {
  blocksAdmission,
  holdsSlot,
  MAX_FIX_ATTEMPTS,
  needsHandBack,
} from './domain/factory-run.js';
import { MAX_INFRA_RETRIES, nextInfraRetry } from './domain/retry-policy.js';
import type { FailureKind } from './domain/step-outcome.js';
import type { FactoryLog } from './infrastructure/factory-log.js';
import type { Clock } from './ports/clock.js';
import type { IssueSource, ReadyIssue, TrustedIssue } from './ports/issue-source.js';
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

/** Where an infrastructure failure is retried: before the pull request, or after it. */
type RetryState = 'queued' | 'waiting_ci';

const handBackComment = (runId: string, reason: string, label: string) =>
  `The issue factory could not finish this issue (run \`${runId}\`): ${reason}\n\nIts branch and pull request, if any, are kept. Add the \`${label}\` label again to start a new factory run.`;

const prNumberOf = (url: string | null) => Number(/\/pull\/(\d+)/.exec(url ?? '')?.[1] ?? NaN);

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
  const isDue = (at: string | undefined) => !at || Date.parse(at) <= clock.now().getTime();
  const slotsLeft = () => settings.limits.concurrency - store.list().filter(holdsSlot).length;

  /** Give the issue back: a comment with the reason, the ready and in-progress labels removed. */
  async function handBack(run: FactoryRun): Promise<FactoryRun> {
    const back = await deps.issues.handBack(run.repo, run.issueNumber, {
      readyLabel: settings.labels.ready,
      inProgressLabel: settings.labels.in_progress,
      comment: handBackComment(run.id, run.reason ?? 'unknown reason', settings.labels.ready),
    });
    if (back.isErr()) {
      // Tried again on the next tick; until then the issue is not admitted again.
      log.warn('Could not hand the issue back', { run: run.id, error: back.error.message });
      return run;
    }
    return runs.update(run, { handedBackAt: clock.now().toISOString() });
  }

  /** The end of a factory run that did not make it: `failed`, and the issue handed back. */
  const giveUp = (run: FactoryRun, reason: string) =>
    handBack(
      runs.transition(run, 'failed', { reason, notBefore: undefined, nextCheckAt: undefined }),
    );

  /**
   * An infrastructure failure: tried again after the configured delay, then
   * twice that; once the retries are used up, the run fails. Before the pull
   * request the run starts over (`queued`); a fix is looked at again
   * (`waiting_ci`), without counting as a fix attempt.
   */
  function onInfraFailure(run: FactoryRun, reason: string, retryIn: RetryState = 'queued') {
    const retries = run.infraRetries ?? 0;
    const at = nextInfraRetry(retries, settings.retry_delay_minutes, clock.now());
    if (!at) {
      return giveUp(run, `infra failure (after ${MAX_INFRA_RETRIES} retries): ${reason}`);
    }
    const when = at.toISOString();
    const change: Partial<FactoryRun> = {
      infraRetries: retries + 1,
      reason: `infra failure: ${reason}; retrying after ${when}`,
    };
    if (retryIn === 'queued') return runs.transition(run, 'queued', { ...change, notBefore: when });
    // Reading CI failed: look again later, in the same state.
    if (run.state === 'waiting_ci') return runs.update(run, { ...change, nextCheckAt: when });
    // A fix that could not run: it was no attempt at fixing CI.
    return runs.transition(run, 'waiting_ci', {
      ...change,
      nextCheckAt: when,
      fixAttempts: Math.max(0, (run.fixAttempts ?? 1) - 1),
    });
  }

  /** A failed step: an agent failure ends the run, an infrastructure one is retried. */
  const onStepFailed = (
    run: FactoryRun,
    outcome: { failure: FailureKind; reason: string },
    retryIn: RetryState = 'queued',
  ) =>
    outcome.failure === 'agent'
      ? giveUp(run, `agent failure: ${outcome.reason}`)
      : onInfraFailure(run, outcome.reason, retryIn);

  function track(runId: string, work: () => Promise<unknown>): void {
    busy.add(runId);
    const running = work()
      .then(() => undefined)
      .catch(async (error) => {
        const reason = `stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
        const aborted = runs.abort(runId, reason);
        if (aborted) await handBack(aborted);
      })
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

  /**
   * What the `implement` step needs: the base branch and the issue's trusted
   * text; the run records them and its branch. A failure is returned as the
   * run it left behind.
   */
  async function startWork(
    project: FactoryProject,
    working: FactoryRun,
  ): Promise<FactoryRun | { run: FactoryRun; trusted: TrustedIssue; base: string }> {
    const base = project.base ?? (await deps.issues.defaultBranch(working.repo).unwrapOr(null));
    if (!base) return onInfraFailure(working, 'could not read the repository default branch');
    const trusted = await deps.issues.readTrusted(
      working.repo,
      working.issueNumber,
      settings.github.login,
    );
    if (trusted.isErr()) {
      return onInfraFailure(working, `could not read the issue: ${trusted.error.message}`);
    }
    // Each attempt has its own branch: an earlier one may have pushed before it failed.
    const retry = working.infraRetries ? `-retry${working.infraRetries}` : '';
    const run = runs.update(working, {
      base,
      branch: `factory/issue-${working.issueNumber}-${working.id.slice(-8)}${retry}`,
      issueTitle: trusted.value.title,
    });
    return { run, trusted: trusted.value, base };
  }

  /** From claiming the issue to the pull request of its `implement` step. */
  async function implementIssue(project: FactoryProject, queued: FactoryRun): Promise<FactoryRun> {
    let run = runs.transition(queued, 'claiming');
    const claimed = await deps.issues.claim(run.repo, run.issueNumber, {
      login: settings.github.login,
      readyLabel: settings.labels.ready,
      inProgressLabel: settings.labels.in_progress,
      // Commented once: a retry of a completed claim does not comment again.
      comment: queued.claimedAt ? undefined : claimComment(run.id),
    });
    if (claimed.isErr())
      return onInfraFailure(run, `could not claim the issue: ${claimed.error.message}`);
    if (!run.claimedAt) run = runs.update(run, { claimedAt: clock.now().toISOString() });

    const working = await startWork(project, runs.transition(run, 'working'));
    if (!('trusted' in working)) return working;
    run = working.run;
    const { trusted, base } = working;

    const workspace = await deps.workspaces.prepare(workspaceRequest(run, project));
    if (workspace.isErr()) {
      return onInfraFailure(run, `could not prepare the workspace: ${workspace.error}`);
    }
    try {
      const outcome = await workspace.value.implement({
        runId: run.id,
        issue: trusted,
        base,
        branch: run.branch!,
        checkCommand: project.check,
        author: settings.github.author,
        model: settings.model,
      });
      if (outcome.kind === 'failed') return onStepFailed(run, outcome);
      if (outcome.kind !== 'pr_opened')
        return onInfraFailure(run, 'the step opened no pull request');
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
    if (!fixing.sessionId) return giveUp(fixing, 'infra failure: no agent session to resume');
    const workspace = await deps.workspaces.reopen(workspaceRequest(fixing, project));
    if (workspace.isErr()) {
      return onInfraFailure(
        fixing,
        `could not reopen the workspace: ${workspace.error}`,
        'waiting_ci',
      );
    }
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
      if (outcome.kind === 'failed') return onStepFailed(fixing, outcome, 'waiting_ci');
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
      return giveUp(run, `agent failure: CI did not pass after ${MAX_FIX_ATTEMPTS} fix attempts`);
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
    return onInfraFailure(run, `could not mark it ready: ${marked.error.message}`, 'waiting_ci');
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
      return onInfraFailure(run, `could not read the CI: ${ci.error.message}`, 'waiting_ci');
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
      store
        .list()
        .some((r) => r.repo === project.repo && r.issueNumber === n && blocksAdmission(r));
    for (const issue of ready.value) {
      if (slotsLeft() <= 0 || settings.limits.daily - store.startedOn(today()) <= 0) return;
      if (issue.author.toLowerCase() !== login || active(issue.number)) continue;
      startRun(project, issue);
    }
  }

  /** Failed runs whose issue could not be handed back yet. */
  function retryHandBacks(): void {
    for (const run of store.list()) {
      if (!needsHandBack(run) || busy.has(run.id)) continue;
      track(run.id, () => handBack(run));
    }
  }

  /** Runs waiting to retry an infrastructure failure whose time has come. */
  function retryDueRuns(projects: FactoryProject[]): void {
    for (const run of store.list()) {
      const project = projects.find((p) => p.repo === run.repo);
      if (run.state !== 'queued' || !run.notBefore || !project || busy.has(run.id)) continue;
      if (!isDue(run.notBefore)) continue;
      if (slotsLeft() <= 0) {
        runs.update(run, { reason: 'retry due; waiting for a free slot' });
        continue;
      }
      const retrying = runs.update(run, { notBefore: undefined });
      track(run.id, () => implementIssue(project, retrying));
    }
  }

  /** Runs waiting for CI whose next look is due. */
  function followDueRuns(projects: FactoryProject[]): void {
    for (const run of store.list()) {
      const project = projects.find((p) => p.repo === run.repo);
      if (run.state !== 'waiting_ci' || !project || busy.has(run.id) || !isDue(run.nextCheckAt)) {
        continue;
      }
      track(run.id, () => followCi(project, run));
    }
  }

  return {
    async tick() {
      // Sandbox workspaces come with #289; until then only worktree projects run.
      const projects = settings.projects.filter((p) => p.workspace === 'worktree');
      followDueRuns(projects);
      retryDueRuns(projects);
      retryHandBacks();
      for (const project of projects) await admit(project);
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
      await runs.flush();
    },
  };
}
