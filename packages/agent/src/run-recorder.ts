/**
 * Records a factory run's progress: every state change goes through the run
 * state machine, is saved to the run store at once (synchronously, so two
 * concurrent decisions see each other), and is reported to the run's event
 * file, in order, in the background.
 */

import { join } from 'path';

import { JsonlRunReporter } from './adapters/jsonl-run-reporter.js';
import { holdsSlot, runStateMachine, type RunState } from './domain/factory-run.js';
import type { FactoryLog } from './infrastructure/factory-log.js';
import type { Clock } from './ports/clock.js';
import type { FactoryRun, RunStore } from './ports/run-store.js';

export interface RunRecorder {
  /** Where the run's files are. */
  runDir(runId: string): string;
  eventsPath(runId: string): string;
  /** Save a new run and report it queued. */
  create(run: FactoryRun): void;
  /** Move `run` to `state` (refused if the state machine forbids it). */
  transition(run: FactoryRun, state: RunState, change?: Partial<FactoryRun>): FactoryRun;
  /**
   * End a run that stopped on an unexpected error while it held a slot
   * (queued, claiming, working, fixing), so it neither stays there nor keeps it.
   */
  abort(runId: string, reason: string): void;
  /** Save other fields without changing the state. */
  update(run: FactoryRun, change: Partial<FactoryRun>): FactoryRun;
  /** Resolves once every event so far is written. */
  flush(): Promise<void>;
}

export function createRunRecorder(deps: {
  store: RunStore;
  clock: Clock;
  log: FactoryLog;
  home: string;
}): RunRecorder {
  const { store, clock, log } = deps;
  const runDir = (runId: string) => join(deps.home, 'runs', runId);
  const eventsPath = (runId: string) => join(runDir(runId), 'events.jsonl');
  let written: Promise<void> = Promise.resolve();

  const reportState = (run: FactoryRun) => {
    const reporter = new JsonlRunReporter(eventsPath(run.id));
    const event = {
      event_type: 'factory.run_state',
      request_id: run.id,
      thread_id: run.id,
      timestamp: clock.now().toISOString(),
      data: {
        state: run.state,
        issue_number: run.issueNumber,
        repo: run.repo,
        ...(run.prUrl ? { pr_url: run.prUrl } : {}),
        ...(run.reason ? { reason: run.reason } : {}),
        ...(run.fixAttempts ? { fix_attempts: run.fixAttempts } : {}),
      },
    };
    written = written
      .then(() => reporter.report(event))
      .catch((error) =>
        log.warn('Could not write a run event', { run: run.id, error: String(error) }),
      );
  };

  return {
    runDir,
    eventsPath,
    create(run) {
      store.save(run);
      reportState(run);
    },
    transition(run, state, change = {}) {
      runStateMachine(run.state as RunState, run.id).transition(state);
      const next = { ...run, ...change, state, updatedAt: clock.now().toISOString() };
      store.save(next);
      reportState(next);
      log.info(`Factory run ${run.id} ${state}`, {
        issue: `${run.repo}#${run.issueNumber}`,
        ...(next.reason ? { reason: next.reason } : {}),
      });
      return next;
    },
    abort(runId, reason) {
      const run = store.list().find((r) => r.id === runId);
      if (!run || !holdsSlot(run.state)) return;
      const next = { ...run, state: 'failed', reason, updatedAt: clock.now().toISOString() };
      store.save(next);
      reportState(next);
      log.error(`Factory run ${runId} failed`, { reason });
    },
    update(run, change) {
      const next = { ...run, ...change, updatedAt: clock.now().toISOString() };
      store.save(next);
      return next;
    },
    flush: () => written,
  };
}
