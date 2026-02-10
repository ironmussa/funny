import { nanoid } from 'nanoid';
import type { ClaudeModel, PermissionMode } from '@a-parallel/shared';
import * as am from './automation-manager.js';
import * as tm from './thread-manager.js';
import * as pm from './project-manager.js';
import * as wm from './worktree-manager.js';
import { startAgent } from './agent-runner.js';
import { wsBroker } from './ws-broker.js';

const POLL_INTERVAL_MS = 30_000; // Check every 30 seconds

let pollTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

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
    console.warn(`[automation-scheduler] Project ${automation.projectId} not found for automation ${automation.id}`);
    return;
  }

  const threadId = nanoid();
  const runId = nanoid();
  const now = new Date().toISOString();

  // Create worktree if mode is worktree
  let worktreePath: string | undefined;
  let threadBranch: string | undefined;

  if (automation.mode === 'worktree') {
    const slug = automation.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 30);
    const branchName = `auto/${slug}-${threadId.slice(0, 6)}`;
    try {
      worktreePath = await wm.createWorktree(
        project.path,
        branchName,
        automation.baseBranch || undefined
      );
      threadBranch = branchName;
    } catch (e: any) {
      console.error(`[automation-scheduler] Failed to create worktree for automation ${automation.id}:`, e.message);
      return;
    }
  }

  // Create the thread
  tm.createThread({
    id: threadId,
    projectId: automation.projectId,
    title: `[Auto] ${automation.name} - ${new Date().toLocaleDateString()}`,
    mode: automation.mode,
    permissionMode: automation.permissionMode,
    status: 'pending',
    branch: threadBranch ?? null,
    baseBranch: automation.mode === 'worktree' ? (automation.baseBranch ?? null) : null,
    worktreePath: worktreePath ?? null,
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

  // Update automation timing
  am.updateAutomation(automation.id, {
    lastRunAt: now,
    nextRunAt: am.computeNextRunAt(automation.schedule, now),
  });

  // Emit WS event
  wsBroker.emit({
    type: 'automation:run_started',
    threadId,
    data: { automationId: automation.id, runId },
  });

  // Start the agent
  const cwd = worktreePath ?? project.path;
  startAgent(
    threadId,
    automation.prompt,
    cwd,
    automation.model as ClaudeModel,
    automation.permissionMode as PermissionMode,
  ).catch((err) => {
    console.error(`[automation-scheduler] Agent error for automation ${automation.id}:`, err);
    am.updateRun(runId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
    });
  });

  console.log(`[automation-scheduler] Triggered run ${runId} for automation "${automation.name}"`);
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

      // Emit WS event for real-time UI update
      wsBroker.emit({
        type: 'automation:run_completed',
        threadId: run.threadId,
        data: {
          automationId: run.automationId,
          runId: run.id,
          hasFindings,
          summary,
        },
      });

      // Auto-dismiss runs with no findings
      if (!hasFindings) {
        am.updateRun(run.id, { triageStatus: 'dismissed' });
      }

      // Cleanup old runs
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
      const thread = tm.getThread(run.threadId);
      if (thread?.worktreePath) {
        const project = pm.getProject(thread.projectId);
        if (project) {
          await wm.removeWorktree(project.path, thread.worktreePath).catch(() => {});
          if (thread.branch) {
            await wm.removeBranch(project.path, thread.branch).catch(() => {});
          }
        }
      }
      tm.updateThread(run.threadId, { archived: 1, worktreePath: null, branch: null });
      am.updateRun(run.id, { status: 'archived' });
    }
  }
}

// ── Poll loop ────────────────────────────────────────────────────

async function pollDueAutomations(): Promise<void> {
  if (running) return;
  running = true;

  try {
    // Trigger due automations
    const dueAutomations = am.getDueAutomations();
    for (const automation of dueAutomations) {
      await triggerAutomationRun(automation);
    }

    // Check for completed runs
    await checkCompletedRuns();
  } catch (e) {
    console.error('[automation-scheduler] Poll error:', e);
  } finally {
    running = false;
  }
}

// ── Lifecycle ────────────────────────────────────────────────────

export function startScheduler(): void {
  // Recalculate stale schedules from when server was off
  am.recalculateStaleSchedules();

  // Immediate first check
  pollDueAutomations();
  pollTimer = setInterval(pollDueAutomations, POLL_INTERVAL_MS);
  console.log('[automation-scheduler] Started (polling every 30s)');
}

export function stopScheduler(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.log('[automation-scheduler] Stopped');
}
