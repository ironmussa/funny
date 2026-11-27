import type { AutomationRun, RunTriageStatus } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { readThreadRow } from '../threads/read';
import { loadInbox } from './loaders';
import { getAutomationsData, getInboxData, getRunsData } from './store';

/**
 * `automation:run_*` realtime events as synced writes into the loaded
 * automation collections, instead of reloading the whole inbox each time.
 */

export function handleRunStarted(
  data: { automationId: string; runId: string; threadId: string },
  layer: DataLayer = getDataLayer(),
): void {
  const run: AutomationRun = {
    id: data.runId,
    automationId: data.automationId,
    threadId: data.threadId,
    status: 'running',
    triageStatus: 'pending',
    startedAt: new Date().toISOString(),
  };
  const runs = getRunsData(layer);
  // A run history that is not loaded is fetched whole when opened.
  if (runs.loadedFor.has(data.automationId) && !runs.getSynced(data.runId)) runs.upsert([run]);

  // The inbox lists running runs too, with their state.
  const inbox = getInboxData(layer);
  if (inbox.getSynced(data.runId)) return;
  const automation = getAutomationsData(layer).getSynced(data.automationId);
  const thread = readThreadRow(data.threadId, layer);
  if (!automation || !thread) {
    void loadInbox(layer);
    return;
  }
  inbox.upsert([{ id: data.runId, run, automation, thread }]);
}

export function handleRunCompleted(
  data: {
    automationId: string;
    runId: string;
    hasFindings: boolean;
    summary?: string;
    threadId: string;
  },
  layer: DataLayer = getDataLayer(),
): void {
  const done = {
    // The server reports a completed thread as findings, a failed one as none.
    status: data.hasFindings ? 'completed' : 'failed',
    hasFindings: data.hasFindings,
    summary: data.summary,
    completedAt: new Date().toISOString(),
  } satisfies Partial<AutomationRun>;
  const runs = getRunsData(layer);
  const run = runs.patch(data.runId, (r) => ({ ...r, ...done })) ?? runs.getSynced(data.runId);

  const inbox = getInboxData(layer);
  if (inbox.patch(data.runId, (row) => ({ ...row, run: { ...row.run, ...done } }))) return;

  // A new inbox item: build it from the rows we have, else ask the server.
  const automation = getAutomationsData(layer).getSynced(data.automationId);
  const thread = readThreadRow(data.threadId, layer);
  if (!automation || !thread) {
    void loadInbox(layer);
    return;
  }
  const inboxRun: AutomationRun = {
    id: data.runId,
    automationId: data.automationId,
    threadId: data.threadId,
    triageStatus: 'pending',
    startedAt: run?.startedAt ?? done.completedAt!,
    ...run,
    ...done,
  };
  inbox.upsert([{ id: data.runId, run: inboxRun, automation, thread }]);
}

export function handleRunUpdated(
  data: { runId: string; triageStatus?: string; status?: string },
  layer: DataLayer = getDataLayer(),
): void {
  const changes: Partial<AutomationRun> = {};
  if (data.triageStatus) {
    // SAFETY: run_updated carries a run row's own triageStatus value;
    // WSAutomationRunUpdatedData only types it as a plain string.
    changes.triageStatus = data.triageStatus as RunTriageStatus;
  }
  if (data.status) {
    // SAFETY: run_updated carries a run row's own status value;
    // WSAutomationRunUpdatedData only types it as a plain string.
    changes.status = data.status as AutomationRun['status'];
  }
  getRunsData(layer).patch(data.runId, (r) => ({ ...r, ...changes }));
  const inbox = getInboxData(layer);
  // The inbox holds running, completed and failed runs.
  if (changes.status === 'archived') inbox.remove([data.runId]);
  else inbox.patch(data.runId, (row) => ({ ...row, run: { ...row.run, ...changes } }));
}
