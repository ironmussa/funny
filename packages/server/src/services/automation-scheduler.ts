/**
 * Server-owned automation scheduler.
 *
 * Holds one cron job per enabled automation and, on each occurrence (or a
 * manual trigger), starts a read-only thread on the automation OWNER's runner
 * through `startThreadOnRunner` — the same path interactive threads take, so
 * runner isolation and the project ↔ runner binding apply unchanged. Runs are
 * recorded in `automation_runs` and completed by `onAutomationThreadTerminal`
 * when the runner persists the thread's terminal status.
 *
 * Single-instance assumption: every server process that calls
 * `startAutomationScheduler` fires every automation.
 *
 * @domain subdomain: Automation
 * @domain type: app-service
 * @domain layer: application
 */

import { AUTOMATION_DISALLOWED_TOOLS } from '@funny/shared/models';
import { Cron } from 'croner';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { err, ok, type Result } from 'neverthrow';

import { db, dbAll, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';
import { log } from '../lib/logger.js';
import * as automationRepo from './automation-repository.js';
import { relayToUser } from './browser-events.js';
import {
  startThreadOnRunner,
  type RunnerPorts,
  type StartThreadError,
} from './runner-thread-launcher.js';

type Automation = typeof schema.automations.$inferSelect;

/** A scheduled job — croner in production, a fake in tests. */
export interface AutomationJob {
  stop(): void;
  nextRun(): Date | null;
}

/** `onTick` settles when the run is recorded, and never rejects. */
export type CreateJob = (pattern: string, onTick: () => Promise<void>) => AutomationJob;

/** A repeating stale-run sweep — an interval in production, a fake in tests. */
export interface SweepTimer {
  stop(): void;
}

/** `onSweep` never rejects. */
export type StartSweep = (onSweep: () => Promise<void>) => SweepTimer;

export interface AutomationSchedulerDeps {
  ports: RunnerPorts;
  createJob?: CreateJob;
  startSweep?: StartSweep;
  /** Launcher override for tests. */
  launch?: typeof startThreadOnRunner;
  now?: () => Date;
}

/** A run still `running` after this long gets marked failed (startup and every sweep). */
export const STALE_RUN_MS = 24 * 60 * 60 * 1000;

/** How often the stale-run sweep runs while the server is up. */
const STALE_RUN_SWEEP_MS = 60 * 60 * 1000;

/**
 * The production sweep. A run whose runner died never reports a terminal
 * status, so without it the run would stay `running` until the next restart
 * (#198). `unref` keeps the timer from holding the process open.
 */
const startIntervalSweep: StartSweep = (onSweep) => {
  const timer = setInterval(() => void onSweep(), STALE_RUN_SWEEP_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
};

/**
 * The production job. Croner awaits the tick's promise, and `protect` skips an
 * occurrence while the previous one is still pending, so a slow dispatch is
 * never overlapped by the next. (The agent run itself finishes later, in
 * `automation-runs.ts`.)
 */
export const createCronJob: CreateJob = (pattern, onTick) =>
  new Cron(pattern, { protect: true }, onTick);

const jobs = new Map<string, AutomationJob>();
let deps: AutomationSchedulerDeps | null = null;
let sweep: SweepTimer | null = null;

const now = () => (deps?.now ?? (() => new Date()))();

// ── Lifecycle ────────────────────────────────────────────────────

export async function startAutomationScheduler(d: AutomationSchedulerDeps): Promise<void> {
  stopAutomationScheduler();
  deps = d;
  await failStaleRuns();
  sweep = (d.startSweep ?? startIntervalSweep)(sweepStaleRuns);
  const enabled = (await automationRepo.listAutomations()).filter((a) => a.enabled);
  for (const automation of enabled) await schedule(automation);
  log.info('Automation scheduler started', { namespace: 'automation', jobs: jobs.size });
}

export function stopAutomationScheduler(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  sweep?.stop();
  sweep = null;
  deps = null;
}

/** Re-read an automation and (re)schedule it — call after create/update. */
export async function rescheduleAutomation(id: string): Promise<void> {
  unscheduleAutomation(id);
  const automation = await automationRepo.getAutomation(id);
  if (!automation) return;
  if (automation.enabled && deps) {
    await schedule(automation);
  } else if (automation.nextRunAt) {
    await automationRepo.updateAutomationRow(id, { nextRunAt: null });
  }
}

/** Stop firing an automation — call after delete. */
export function unscheduleAutomation(id: string): void {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

/** Number of scheduled jobs (diagnostics / tests). */
export function scheduledAutomationCount(): number {
  return jobs.size;
}

async function schedule(automation: Automation): Promise<void> {
  if (!deps) return;
  let job: AutomationJob;
  try {
    job = (deps.createJob ?? createCronJob)(automation.schedule, () => tick(automation.id));
  } catch (e) {
    log.warn('Invalid automation schedule — not scheduled', {
      namespace: 'automation',
      automationId: automation.id,
      schedule: automation.schedule,
      error: (e as Error).message,
    });
    return;
  }
  jobs.set(automation.id, job);
  await recordNextRun(automation.id);
}

async function recordNextRun(id: string): Promise<void> {
  const next = jobs.get(id)?.nextRun();
  await automationRepo.updateAutomationRow(id, { nextRunAt: next ? next.toISOString() : null });
}

/**
 * One occurrence. Returning the promise is what lets croner's `protect` skip
 * the next occurrence while this one runs; a failure is logged here because
 * croner does not catch what the tick rejects with (#185).
 */
function tick(id: string): Promise<void> {
  return logFailure(fire(id), 'Automation tick failed', { automationId: id });
}

/** Settle `work`, logging a rejection instead of passing it on to a timer. */
function logFailure(
  work: Promise<void>,
  message: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  return work.catch((error: unknown) => {
    log.error(message, {
      namespace: 'automation',
      ...fields,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function fire(id: string): Promise<void> {
  // Re-read so an edit that raced the tick (prompt, model, disable) is honored.
  const automation = await automationRepo.getAutomation(id);
  if (!automation?.enabled) return;
  if (await hasRunInProgress(id)) {
    log.info('Automation tick skipped: the previous run is still running', {
      namespace: 'automation',
      automationId: id,
    });
  } else {
    await runAutomation(automation);
  }
  await recordNextRun(id);
}

/**
 * Whether a scheduled tick would overlap the previous run: one still
 * `running` (its thread has not reported a terminal status). A run older than
 * `STALE_RUN_MS` does not count, so one lost completion cannot stop the
 * automation for good; the stale-run sweep marks those failed. Manual runs skip this.
 */
async function hasRunInProgress(automationId: string): Promise<boolean> {
  const since = new Date(now().getTime() - STALE_RUN_MS).toISOString();
  const active = await dbAll(
    db
      .select({ id: schema.automationRuns.id })
      .from(schema.automationRuns)
      .where(
        and(
          eq(schema.automationRuns.automationId, automationId),
          eq(schema.automationRuns.status, 'running'),
          gte(schema.automationRuns.startedAt, since),
        ),
      )
      .limit(1),
  );
  return active.length > 0;
}

// ── Dispatch ─────────────────────────────────────────────────────

export interface StartedRun {
  runId: string;
  threadId: string;
}

/**
 * Start one run now (scheduled tick or manual trigger). A dispatch failure is
 * still recorded as a failed run so it shows in the owner's history.
 */
export async function runAutomation(
  automation: Automation,
): Promise<Result<StartedRun, StartThreadError>> {
  if (!deps) {
    return err({ kind: 'runner-unavailable', status: 502, message: 'Scheduler not started' });
  }
  const runId = nanoid();
  const startedAt = now().toISOString();
  const title = `[Auto] ${automation.name} - ${now().toLocaleDateString()}`;

  const launched = await (deps.launch ?? startThreadOnRunner)(
    {
      userId: automation.userId,
      body: {
        projectId: automation.projectId,
        title,
        mode: 'local',
        source: 'automation',
        provider: automation.provider,
        model: automation.model,
        permissionMode: automation.permissionMode,
        prompt: automation.prompt,
        disallowedTools: [...AUTOMATION_DISALLOWED_TOOLS],
      },
    },
    deps.ports,
  );

  const threadId = launched.isOk() ? launched.value.threadId : undefined;
  if (launched.isErr() || !threadId) {
    const error: StartThreadError = launched.isErr()
      ? launched.error
      : { kind: 'runner-error', status: 502, message: 'Runner returned no thread id' };
    await recordFailedDispatch(automation, runId, title, startedAt, error.message);
    log.warn('Automation run could not start', {
      namespace: 'automation',
      automationId: automation.id,
      runId,
      reason: error.message,
    });
    return err(error);
  }

  await automationRepo.createRun({
    id: runId,
    automationId: automation.id,
    threadId,
    status: 'running',
    triageStatus: 'pending',
    startedAt,
  });
  await automationRepo.updateAutomationRow(automation.id, { lastRunAt: startedAt });
  relayToUser(automation.userId, {
    type: 'automation:run_started',
    threadId,
    data: { automationId: automation.id, runId },
  });
  log.info('Automation run started', {
    namespace: 'automation',
    automationId: automation.id,
    runId,
    threadId,
  });
  return ok({ runId, threadId });
}

/**
 * `automation_runs.thread_id` is a required FK, so a run that never reached a
 * runner is recorded against an archived placeholder thread that carries the
 * failure. It shows in the run history and inbox like any failed run.
 */
async function recordFailedDispatch(
  automation: Automation,
  runId: string,
  title: string,
  startedAt: string,
  reason: string,
): Promise<void> {
  const threadId = nanoid();
  await dbRun(
    db.insert(schema.threads).values({
      id: threadId,
      projectId: automation.projectId,
      userId: automation.userId,
      title,
      mode: 'local',
      status: 'failed',
      source: 'automation',
      archived: 1,
      completedAt: startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    } as any),
  );
  const summary = `Run could not start: ${reason}`;
  await automationRepo.createRun({
    id: runId,
    automationId: automation.id,
    threadId,
    status: 'failed',
    triageStatus: 'pending',
    startedAt,
  });
  await automationRepo.updateRun(runId, { hasFindings: 0, summary, completedAt: startedAt });
  await automationRepo.updateAutomationRow(automation.id, { lastRunAt: startedAt });
  relayToUser(automation.userId, {
    type: 'automation:run_completed',
    threadId,
    data: { automationId: automation.id, runId, hasFindings: false, summary },
  });
}

/** One periodic sweep. A failure is logged, never thrown into the timer. */
function sweepStaleRuns(): Promise<void> {
  return logFailure(failStaleRuns(), 'Stale automation run sweep failed');
}

const STALE_RUN_SUMMARY = 'No completion was reported for this run';

/** Runs whose thread never reported a terminal status don't stay `running` forever. */
async function failStaleRuns(): Promise<void> {
  const cutoff = new Date(now().getTime() - STALE_RUN_MS).toISOString();
  const stale = (await dbAll(
    db
      .select({
        id: schema.automationRuns.id,
        threadId: schema.automationRuns.threadId,
        automationId: schema.automationRuns.automationId,
        userId: schema.automations.userId,
      })
      .from(schema.automationRuns)
      .innerJoin(schema.automations, eq(schema.automations.id, schema.automationRuns.automationId))
      .where(
        and(
          eq(schema.automationRuns.status, 'running'),
          lt(schema.automationRuns.startedAt, cutoff),
        ),
      )
      .orderBy(asc(schema.automationRuns.startedAt)),
  )) as { id: string; threadId: string; automationId: string; userId: string }[];
  let failed = 0;
  for (const run of stale) {
    // Only a run still `running`: a completion that landed after the select wins.
    const updated = await db
      .update(schema.automationRuns)
      .set({
        status: 'failed',
        hasFindings: 0,
        summary: STALE_RUN_SUMMARY,
        completedAt: now().toISOString(),
      })
      .where(and(eq(schema.automationRuns.id, run.id), eq(schema.automationRuns.status, 'running')))
      .returning({ id: schema.automationRuns.id });
    if (updated.length === 0) continue;
    failed++;
    // The sweep also runs while browsers are open, so tell the owner's.
    relayToUser(run.userId, {
      type: 'automation:run_completed',
      threadId: run.threadId,
      data: {
        automationId: run.automationId,
        runId: run.id,
        hasFindings: false,
        summary: STALE_RUN_SUMMARY,
      },
    });
  }
  if (failed) {
    log.warn('Marked stale automation runs as failed', { namespace: 'automation', count: failed });
  }
}
