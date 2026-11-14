/**
 * The issue factory: on each tick it admits ready issues and takes each one
 * through a factory run (`queued → claiming → working → pr_open`).
 *
 * Composed from ports, so the same code runs in production (`cli.ts`) and in
 * the whole-factory tests, which fake only GitHub (over HTTP), the agent and
 * the clock.
 *
 * Admission here is the tracer bullet's: open issues with the ready label,
 * opened by the configured login, without an active run, oldest first, within
 * the concurrency and daily limits. Assignee and blocker rules come with #284.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';

import { JsonlRunReporter } from './adapters/jsonl-run-reporter.js';
import { holdsSlot, isActive, runStateMachine, type RunState } from './domain/factory-run.js';
import type { FactoryLog } from './infrastructure/factory-log.js';
import type { Clock } from './ports/clock.js';
import type { IssueSource, ReadyIssue } from './ports/issue-source.js';
import type { FactoryRun, RunStore } from './ports/run-store.js';
import type { WorkspaceProvider } from './ports/workspaces.js';
import type { FactoryProject, FactorySettings } from './settings/schema.js';

export interface FactoryDeps {
  settings: FactorySettings;
  issues: IssueSource;
  workspaces: WorkspaceProvider;
  store: RunStore;
  clock: Clock;
  log: FactoryLog;
  /** The factory home; runs live in `<home>/runs/<runId>/`. */
  home: string;
}

export interface Factory {
  /** Admit what can be admitted now; started runs continue in the background. */
  tick(): Promise<void>;
  /** Resolves once every started run has reached a state where it waits. */
  idle(): Promise<void>;
}

/** Where a run's files are; its event file is `events.jsonl` in it. */
const runDirectory = (home: string, runId: string) => join(home, 'runs', runId);

const claimComment = (runId: string) =>
  `The issue factory is working on this issue (run \`${runId}\`). It will open a draft pull request that closes it.`;

export function createFactory(deps: FactoryDeps): Factory {
  const { settings, store, clock, log } = deps;
  const inFlight = new Set<Promise<void>>();
  const today = () => clock.now().toISOString().slice(0, 10);

  const activeRunFor = (repo: string, issue: number) =>
    store.list().some((r) => r.repo === repo && r.issueNumber === issue && isActive(r.state));

  /** One factory run, from claiming the issue to the outcome of its `implement` step. */
  async function runIssue(project: FactoryProject, issue: ReadyIssue): Promise<void> {
    const runId = `r-${issue.number}-${randomUUID().slice(0, 8)}`;
    const runDir = runDirectory(deps.home, runId);
    const eventsPath = join(runDir, 'events.jsonl');
    const reporter = new JsonlRunReporter(eventsPath);
    const machine = runStateMachine('queued', runId);
    const createdAt = clock.now().toISOString();
    let run: FactoryRun = {
      id: runId,
      repo: project.repo,
      issueNumber: issue.number,
      state: 'queued',
      prUrl: null,
      reason: null,
      createdAt,
      updatedAt: createdAt,
    };
    const report = (event_type: string, data: Record<string, unknown>) =>
      reporter
        .report({
          event_type,
          request_id: runId,
          thread_id: runId,
          timestamp: clock.now().toISOString(),
          data,
        })
        .catch((error) =>
          log.warn('Could not write a run event', { run: runId, error: String(error) }),
        );
    const moveTo = async (state: RunState, change: Partial<FactoryRun> = {}) => {
      machine.transition(state);
      run = { ...run, ...change, state, updatedAt: clock.now().toISOString() };
      store.save(run);
      await report('factory.run_state', {
        state,
        issue_number: issue.number,
        repo: project.repo,
        ...(run.prUrl ? { pr_url: run.prUrl } : {}),
        ...(run.reason ? { reason: run.reason } : {}),
      });
      log.info(`Factory run ${runId} ${state}`, { issue: `${project.repo}#${issue.number}` });
    };
    const failWith = (reason: string) => moveTo('failed', { reason });

    store.save(run);
    store.recordStart(today());
    await report('factory.run_state', {
      state: 'queued',
      issue_number: issue.number,
      repo: project.repo,
    });

    await moveTo('claiming');
    const claimed = await deps.issues.claim(project.repo, issue.number, {
      login: settings.github.login,
      readyLabel: settings.labels.ready,
      inProgressLabel: settings.labels.in_progress,
      comment: claimComment(runId),
    });
    if (claimed.isErr()) return failWith(`could not claim the issue: ${claimed.error.message}`);

    await moveTo('working');
    const base = project.base
      ? project.base
      : await deps.issues.defaultBranch(project.repo).match(
          (branch) => branch,
          () => null,
        );
    if (!base) return failWith('could not read the repository default branch');
    const trusted = await deps.issues.readTrusted(
      project.repo,
      issue.number,
      settings.github.login,
    );
    if (trusted.isErr()) return failWith(`could not read the issue: ${trusted.error.message}`);

    const branch = `factory/issue-${issue.number}-${runId.slice(-8)}`;
    const workspace = await deps.workspaces.prepare({
      runId,
      runDir,
      eventsPath,
      repo: project.repo,
      projectPath: project.path,
      base,
      branch,
    });
    if (workspace.isErr()) return failWith(`could not prepare the workspace: ${workspace.error}`);
    try {
      const outcome = await workspace.value.implement({
        runId,
        issue: trusted.value,
        base,
        branch,
        checkCommand: project.check,
        author: settings.github.author,
        model: settings.model,
      });
      if (outcome.kind === 'pr_opened') await moveTo('pr_open', { prUrl: outcome.prUrl });
      else await failWith(`${outcome.failure} failure: ${outcome.reason}`);
    } finally {
      await workspace.value.release();
    }
  }

  function start(project: FactoryProject, issue: ReadyIssue): void {
    const running = runIssue(project, issue)
      .catch((error) =>
        log.error('A factory run stopped unexpectedly', {
          issue: `${project.repo}#${issue.number}`,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => inFlight.delete(running));
    inFlight.add(running);
  }

  async function admit(project: FactoryProject): Promise<void> {
    const ready = await deps.issues.listReady(project.repo, settings.labels.ready);
    if (ready.isErr()) {
      log.warn('Could not list ready issues', { repo: project.repo, error: ready.error.message });
      return;
    }
    const login = settings.github.login.toLowerCase();
    for (const issue of ready.value) {
      const slots =
        settings.limits.concurrency - store.list().filter((r) => holdsSlot(r.state)).length;
      const dailyLeft = settings.limits.daily - store.startedOn(today());
      if (slots <= 0 || dailyLeft <= 0) return;
      if (issue.author.toLowerCase() !== login) continue;
      if (activeRunFor(project.repo, issue.number)) continue;
      start(project, issue);
    }
  }

  return {
    async tick() {
      for (const project of settings.projects) {
        // Sandbox workspaces come with #289; until then only worktree projects run.
        if (project.workspace !== 'worktree') continue;
        await admit(project);
      }
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
