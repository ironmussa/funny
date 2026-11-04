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
  const runs = getRunsData(layer);
  // A run history that is not loaded is fetched whole when opened.
  if (!runs.loadedFor.has(data.automationId) || runs.getSynced(data.runId)) return;
  runs.upsert([
    {
      id: data.runId,
      automationId: data.automationId,
      threadId: data.threadId,
      status: 'running',
      triageStatus: 'pending',
      startedAt: new Date().toISOString(),
    },
  ]);
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
  const done: Partial<AutomationRun> = {
    // The server reports a completed thread as findings, a failed one as none.
    status: data.hasFindings ? 'completed' : 'failed',
    hasFindings: data.hasFindings,
    summary: data.summary,
    completedAt: new Date().toISOString(),
  };
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
  } as AutomationRun;
  inbox.upsert([{ id: data.runId, run: inboxRun, automation, thread }]);
}

export function handleRunUpdated(
  data: { runId: string; triageStatus?: string; status?: string },
  layer: DataLayer = getDataLayer(),
): void {
  const changes: Partial<AutomationRun> = {};
  if (data.triageStatus) changes.triageStatus = data.triageStatus as RunTriageStatus;
  if (data.status) changes.status = data.status as AutomationRun['status'];
  getRunsData(layer).patch(data.runId, (r) => ({ ...r, ...changes }));
  const inbox = getInboxData(layer);
  // The inbox holds completed/failed runs only.
  if (changes.status === 'archived' || changes.status === 'running') inbox.remove([data.runId]);
  else inbox.patch(data.runId, (row) => ({ ...row, run: { ...row.run, ...changes } }));
}
