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
import { and, asc, eq, lt } from 'drizzle-orm';
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

export type CreateJob = (pattern: string, onTick: () => void) => AutomationJob;

export interface AutomationSchedulerDeps {
  ports: RunnerPorts;
  createJob?: CreateJob;
  /** Launcher override for tests. */
  launch?: typeof startThreadOnRunner;
  now?: () => Date;
}

/** A run still `running` after this long gets marked failed on startup. */
export const STALE_RUN_MS = 24 * 60 * 60 * 1000;

const defaultCreateJob: CreateJob = (pattern, onTick) =>
  new Cron(pattern, { protect: true }, onTick);

const jobs = new Map<string, AutomationJob>();
let deps: AutomationSchedulerDeps | null = null;

const now = () => (deps?.now ?? (() => new Date()))();

// ── Lifecycle ────────────────────────────────────────────────────

export async function startAutomationScheduler(d: AutomationSchedulerDeps): Promise<void> {
  stopAutomationScheduler();
  deps = d;
  await failStaleRuns();
  const enabled = (await automationRepo.listAutomations()).filter((a) => a.enabled);
  for (const automation of enabled) await schedule(automation);
  log.info('Automation scheduler started', { namespace: 'automation', jobs: jobs.size });
}

export function stopAutomationScheduler(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
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
    job = (deps.createJob ?? defaultCreateJob)(automation.schedule, () => {
      void fire(automation.id);
    });
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

async function fire(id: string): Promise<void> {
  // Re-read so an edit that raced the tick (prompt, model, disable) is honored.
  const automation = await automationRepo.getAutomation(id);
  if (!automation?.enabled) return;
  await runAutomation(automation);
  await recordNextRun(id);
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

/** Runs whose thread never reported a terminal status don't stay `running` forever. */
async function failStaleRuns(): Promise<void> {
  const cutoff = new Date(now().getTime() - STALE_RUN_MS).toISOString();
  const stale = await dbAll(
    db
      .select({ id: schema.automationRuns.id })
      .from(schema.automationRuns)
      .where(
        and(
          eq(schema.automationRuns.status, 'running'),
          lt(schema.automationRuns.startedAt, cutoff),
        ),
      )
      .orderBy(asc(schema.automationRuns.startedAt)),
  );
  for (const { id } of stale as { id: string }[]) {
    await automationRepo.updateRun(id, {
      status: 'failed',
      hasFindings: 0,
      summary: 'No completion was reported for this run',
      completedAt: now().toISOString(),
    });
  }
  if (stale.length) {
    log.warn('Marked stale automation runs as failed', {
      namespace: 'automation',
      count: stale.length,
    });
  }
}
