import { Cron } from 'croner';
import { nanoid } from 'nanoid';
import type { AgentModel, AgentProvider, PermissionMode } from '@funny/shared';
import * as am from './automation-manager.js';
import * as tm from './thread-manager.js';
import * as pm from './project-manager.js';
import { startAgent } from './agent-runner.js';
import { wsBroker } from './ws-broker.js';
import { log } from '../lib/abbacchio.js';

// Tools that automations are NOT allowed to use (read-only execution)
const AUTOMATION_DISALLOWED_TOOLS = ['Edit', 'Write', 'Bash', 'NotebookEdit'];

// ── Active cron jobs ─────────────────────────────────────────────
// Each automation gets its own Cron instance. We track them here
// so we can stop/reschedule when automations are updated or deleted.

const activeJobs = new Map<string, Cron>();

// Lightweight poll for checking completed runs (no cron needed for this)
const COMPLETED_RUNS_POLL_MS = 15_000;
let completedRunsTimer: ReturnType<typeof setInterval> | null = null;

// ── Trigger a single automation run ──────────────────────────────

export async function triggerAutomationRun(automation: {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  schedule: string;
  model: string;
  mode: string;
  permissionMode: string;
  baseBranch: string | null;
}): Promise<void> {
  const project = pm.getProject(automation.projectId);
  if (!project) {
    log.warn('Project not found for automation', { namespace: 'automation', projectId: automation.projectId, automationId: automation.id });
    return;
  }

  const threadId = nanoid();
  const runId = nanoid();
  const now = new Date().toISOString();

  // Automations always run in local mode (no worktree) and read-only
  tm.createThread({
    id: threadId,
    projectId: automation.projectId,
    title: `[Auto] ${automation.name} - ${new Date().toLocaleDateString()}`,
    mode: 'local',
    permissionMode: automation.permissionMode,
    status: 'pending',
    branch: null,
    baseBranch: null,
    worktreePath: null,
    source: 'automation',
    automationId: automation.id,
    cost: 0,
    archived: 0,
    createdAt: now,
  });

  // Create the automation run record
  am.createRun({
    id: runId,
    automationId: automation.id,
    threadId,
    status: 'running',
    triageStatus: 'pending',
    startedAt: now,
  });

  // Update automation last run time
  am.updateAutomation(automation.id, { lastRunAt: now });

  // Emit WS event — look up project userId for per-user filtering
  const runStartEvent = {
    type: 'automation:run_started' as const,
    threadId,
    data: { automationId: automation.id, runId },
  };
  if (project.userId && project.userId !== '__local__') {
    wsBroker.emitToUser(project.userId, runStartEvent);
  } else {
    wsBroker.emit(runStartEvent);
  }

  // Start the agent (local mode, read-only — no file writes allowed)
  startAgent(
    threadId,
    automation.prompt,
    project.path,
    automation.model as AgentModel,
    automation.permissionMode as PermissionMode,
    undefined, // images
    AUTOMATION_DISALLOWED_TOOLS,
    undefined, // allowedTools
    (automation as any).provider as AgentProvider || 'claude',
  ).catch((err) => {
    log.error('Agent error for automation', { namespace: 'automation', automationId: automation.id, error: err });
    am.updateRun(runId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
    });
  });

  log.info(`Triggered run for "${automation.name}"`, { namespace: 'automation', runId, automationId: automation.id });
}

// ── Cron job management ──────────────────────────────────────────

/** Schedule a cron job for one automation */
function scheduleJob(automation: { id: string; schedule: string; enabled: number; name: string }): void {
  // Remove existing job if any
  unscheduleJob(automation.id);

  if (!automation.enabled) return;

  try {
    const job = new Cron(automation.schedule, { name: automation.id }, async () => {
      // Re-fetch the automation to get latest state (it may have been disabled)
      const current = am.getAutomation(automation.id);
      if (!current || !current.enabled) {
        unscheduleJob(automation.id);
        return;
      }
      await triggerAutomationRun(current);
    });

    activeJobs.set(automation.id, job);

    const next = job.nextRun();
    log.info(`Scheduled "${automation.name}"`, { namespace: 'automation', schedule: automation.schedule, nextRun: next?.toISOString() ?? 'never' });
  } catch (e: any) {
    log.error('Invalid cron expression', { namespace: 'automation', automationId: automation.id, schedule: automation.schedule, error: e.message });
  }
}

/** Remove a cron job for an automation */
function unscheduleJob(automationId: string): void {
  const existing = activeJobs.get(automationId);
  if (existing) {
    existing.stop();
    activeJobs.delete(automationId);
  }
}

/** Get next run time for an automation */
export function getNextRun(automationId: string): Date | null {
  const job = activeJobs.get(automationId);
  return job?.nextRun() ?? null;
}

// ── Public API for dynamic updates ───────────────────────────────
// Called by automation-manager when automations are created/updated/deleted

export function onAutomationCreated(automation: { id: string; schedule: string; enabled: number; name: string }): void {
  scheduleJob(automation);
}

export function onAutomationUpdated(automation: { id: string; schedule: string; enabled: number; name: string }): void {
  scheduleJob(automation);
}

export function onAutomationDeleted(automationId: string): void {
  unscheduleJob(automationId);
}

// ── Check completed runs ─────────────────────────────────────────

async function checkCompletedRuns(): Promise<void> {
  const runningRuns = am.listRunningRuns();
  for (const run of runningRuns) {
    const thread = tm.getThread(run.threadId);
    if (!thread) continue;

    if (['completed', 'failed', 'stopped'].includes(thread.status)) {
      const hasFindings = thread.status === 'completed';

      // Generate a summary from the last assistant message
      const threadData = tm.getThreadWithMessages(run.threadId);
      const lastAssistantMsg = threadData?.messages
        ?.filter((m: any) => m.role === 'assistant')
        ?.pop();
      const summary = lastAssistantMsg?.content?.slice(0, 500) || 'No summary available';

      am.updateRun(run.id, {
        status: thread.status === 'completed' ? 'completed' : 'failed',
        hasFindings: hasFindings ? 1 : 0,
        summary,
        completedAt: thread.completedAt || new Date().toISOString(),
      });

      const runCompleteEvent = {
        type: 'automation:run_completed' as const,
        threadId: run.threadId,
        data: {
          automationId: run.automationId,
          runId: run.id,
          hasFindings,
          summary,
        },
      };
      // Emit per-user if thread has userId
      if (thread.userId && thread.userId !== '__local__') {
        wsBroker.emitToUser(thread.userId, runCompleteEvent);
      } else {
        wsBroker.emit(runCompleteEvent);
      }

      if (!hasFindings) {
        am.updateRun(run.id, { triageStatus: 'dismissed' });
      }

      await cleanupOldRuns(run.automationId);
    }
  }
}

// ── Worktree cleanup ─────────────────────────────────────────────

async function cleanupOldRuns(automationId: string): Promise<void> {
  const automation = am.getAutomation(automationId);
  if (!automation) return;

  const runs = am.listRuns(automationId);
  const reviewedRuns = runs.filter(r =>
    r.triageStatus !== 'pending' && r.status !== 'running'
  );

  if (reviewedRuns.length > automation.maxRunHistory) {
    const toRemove = reviewedRuns.slice(automation.maxRunHistory);
    for (const run of toRemove) {
      tm.updateThread(run.threadId, { archived: 1 });
      am.updateRun(run.id, { status: 'archived' });
    }
  }
}

// ── Lifecycle ────────────────────────────────────────────────────

export function startScheduler(): void {
  // Schedule cron jobs for all enabled automations
  const automations = am.listAutomations();
  for (const automation of automations) {
    scheduleJob(automation);
  }

  // Start polling for completed runs
  checkCompletedRuns();
  completedRunsTimer = setInterval(checkCompletedRuns, COMPLETED_RUNS_POLL_MS);

  log.info(`Scheduler started`, { namespace: 'automation', activeJobs: automations.filter(a => a.enabled).length });
}

export function stopScheduler(): void {
  // Stop all cron jobs
  for (const [id, job] of activeJobs) {
    job.stop();
  }
  activeJobs.clear();

  // Stop completed-runs polling
  if (completedRunsTimer) {
    clearInterval(completedRunsTimer);
    completedRunsTimer = null;
  }

  log.info('Scheduler stopped', { namespace: 'automation' });
}
