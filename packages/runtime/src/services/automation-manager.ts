/**
 * @domain subdomain: Automation
 * @domain subdomain-type: supporting
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain aggregate: Automation
 * @domain depends: RuntimeServiceProvider, AutomationScheduler
 *
 * Delegates all DB operations to the injected service provider.
 * Scheduler hooks (create/update/delete notifications) are applied
 * locally since the scheduler runs in the runtime process.
 */

import { DEFAULT_MODEL, DEFAULT_THREAD_MODE, DEFAULT_PERMISSION_MODE } from '@funny/shared/models';
import { nanoid } from 'nanoid';

import { getServices } from './service-registry.js';

// Lazy import to avoid circular dependency (scheduler imports us)
let schedulerHooks: {
  onAutomationCreated: (a: any) => void;
  onAutomationUpdated: (a: any) => void;
  onAutomationDeleted: (id: string) => void;
} | null = null;

async function getSchedulerHooks() {
  if (!schedulerHooks) {
    const mod = await import('./automation-scheduler.js');
    schedulerHooks = {
      onAutomationCreated: mod.onAutomationCreated,
      onAutomationUpdated: mod.onAutomationUpdated,
      onAutomationDeleted: mod.onAutomationDeleted,
    };
  }
  return schedulerHooks;
}

// ── Automation CRUD ──────────────────────────────────────────────

export function listAutomations(projectId?: string, userId?: string) {
  return getServices().automations.listAutomations(projectId, userId);
}

export function getAutomation(id: string) {
  return getServices().automations.getAutomation(id);
}

export async function createAutomation(data: {
  projectId: string;
  name: string;
  prompt: string;
  schedule: string;
  model?: string;
  permissionMode?: string;
  userId?: string;
}) {
  const id = nanoid();
  const now = new Date().toISOString();

  await getServices().automations.insertAutomation({
    id,
    projectId: data.projectId,
    userId: data.userId || '',
    name: data.name,
    prompt: data.prompt,
    schedule: data.schedule,
    model: data.model || DEFAULT_MODEL,
    mode: DEFAULT_THREAD_MODE,
    permissionMode: data.permissionMode || DEFAULT_PERMISSION_MODE,
    enabled: 1,
    maxRunHistory: 20,
    createdAt: now,
    updatedAt: now,
  });

  const automation = (await getAutomation(id))!;

  // Notify scheduler to create a cron job
  const hooks = await getSchedulerHooks();
  hooks.onAutomationCreated(automation);

  return automation;
}

export async function updateAutomation(id: string, updates: Record<string, any>) {
  await getServices().automations.updateAutomationRow(id, updates);

  // Notify scheduler to reschedule the cron job
  const automation = await getAutomation(id);
  if (automation) {
    const hooks = await getSchedulerHooks();
    hooks.onAutomationUpdated(automation);
  }
}

export async function deleteAutomation(id: string) {
  // Notify scheduler before deleting
  const hooks = await getSchedulerHooks();
  hooks.onAutomationDeleted(id);

  await getServices().automations.deleteAutomationRow(id);
}

// ── Run CRUD ─────────────────────────────────────────────────────

export function createRun(data: {
  id: string;
  automationId: string;
  threadId: string;
  status: string;
  triageStatus: string;
  startedAt: string;
}) {
  return getServices().automations.createRun(data);
}

export function updateRun(id: string, updates: Record<string, any>) {
  return getServices().automations.updateRun(id, updates);
}

export function listRuns(automationId: string) {
  return getServices().automations.listRuns(automationId);
}

export function listRunningRuns() {
  return getServices().automations.listRunningRuns();
}

export function getRunByThreadId(threadId: string) {
  return getServices().automations.getRunByThreadId(threadId);
}

export function listPendingReviewRuns(projectId?: string) {
  return getServices().automations.listPendingReviewRuns(projectId);
}

export function listInboxRuns(options?: { projectId?: string; triageStatus?: string }) {
  return getServices().automations.listInboxRuns(options);
}
