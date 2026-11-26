/** `agent:result`, and the toast that reports how the run ended. */

import type { MessageRole, Thread, ThreadStatus } from '@funny/shared';
import { toast } from 'sonner';

import { readThreadIndex, readThreadRow } from '@/data/threads/read';
import { isFactoryThread, isScratch } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';

import { settlePreSendState } from '../optimistic-run-state';
import { useSidebarFilterStore } from '../sidebar-filter-store';
import { useThreadActiveToolStore } from '../thread-active-tool-store';
import {
  invalidateThreadData,
  transitionThreadStatus,
  wsEventToMachineEvent,
} from '../thread-machine-bridge';
import * as mutations from '../thread-mutations';
import { useThreadReadStore } from '../thread-read-store';
import { getNavigate, getProjectIdForThread, getUrlThreadId } from '../thread-store-internals';
import {
  dequeuedUserAlreadyShownInTurn,
  hasAssistantContentAfterLastUser,
  buildDequeuedUserMessage,
  pendingDequeuedMessages,
  resultTextToAssistantMessage,
  trailingAssistantScaffoldStart,
} from './dequeued-messages';
import {
  isHydrated,
  maybeBuffer,
  patchSidebarLastAssistant,
  patchSidebarThread,
  scheduleProjectRefresh,
  terminalTimestamps,
  wsLog,
  type Get,
  type Set,
} from './shared';

// ── Result ──────────────────────────────────────────────────────

/** Whether an `agent:result` changes any sidebar-visible field of the row. */
function resultChangesRow(
  t: Thread,
  nextStatus: ThreadStatus,
  data: any,
  statusTimestamps: Partial<Thread>,
): boolean {
  if (nextStatus !== t.status || Object.keys(statusTimestamps).length > 0) return true;
  if (data.cost !== undefined && data.cost !== t.cost) return true;
  return Boolean(data.stage) && data.stage !== t.stage;
}

/** The row after an `agent:result`; the same reference when nothing changed. */
function applyResultToRow(t: Thread, nextStatus: ThreadStatus, data: any): Thread {
  const statusTimestamps = terminalTimestamps(nextStatus);
  if (!resultChangesRow(t, nextStatus, data, statusTimestamps)) return t;
  return {
    ...t,
    status: nextStatus,
    cost: data.cost ?? t.cost,
    ...statusTimestamps,
    stage: data.stage ? data.stage : t.stage,
  };
}

const TERMINAL_READ_STATUSES = new Set<ThreadStatus>([
  'completed',
  'failed',
  'stopped',
  'interrupted',
]);

function applyThreadPayloadResult<T extends Thread>(
  t: T,
  machineEvent: NonNullable<ReturnType<typeof wsEventToMachineEvent>>,
  serverStatus: ThreadStatus,
  data: any,
  threadId: string,
): T {
  const newStatus = transitionThreadStatus(threadId, machineEvent, t.status, data.cost ?? t.cost);
  const finalStatus = newStatus !== t.status ? newStatus : serverStatus;
  if (finalStatus === 'waiting') {
    if (!data.waitingReason) {
      wsLog.warn(
        'BUG-HUNT: agent:result waiting but NO waitingReason — will show generic WaitingActions instead of question/plan card',
        { threadId },
      );
    }
    return {
      ...t,
      status: finalStatus,
      cost: data.cost ?? t.cost,
      waitingReason: data.waitingReason,
      pendingPermission: data.permissionRequest,
      stage: data.stage ? data.stage : t.stage,
    };
  }
  return {
    ...t,
    status: finalStatus,
    cost: data.cost ?? t.cost,
    ...terminalTimestamps(finalStatus),
    waitingReason: undefined,
    pendingPermission: undefined,
    resultInfo: {
      // SAFETY: machineEvent is non-null only for a completed / failed / waiting result, and
      // waiting returned above; COMPLETE and FAIL only move to 'completed' or 'failed', and an
      // unchanged status falls back to the server's, so finalStatus is one of those two.
      status: finalStatus as 'completed' | 'failed',
      cost: data.cost ?? t.cost,
      duration: data.duration ?? 0,
      error: data.error,
    },
    stage: data.stage ? data.stage : t.stage,
  };
}

function flushOrphanedDequeuedMessage(get: Get, set: Set, threadId: string): void {
  const orphaned = pendingDequeuedMessages.get(threadId);
  if (!orphaned) return;
  pendingDequeuedMessages.delete(threadId);
  if (!isHydrated(get(), threadId)) return;
  set((s) =>
    mutations.applyThreadDataPatch(s, threadId, (t) => {
      if (dequeuedUserAlreadyShownInTurn(t.messages, orphaned.content)) return t;
      const insertionIndex = trailingAssistantScaffoldStart(t.messages);
      const messages = t.messages.slice();
      messages.splice(insertionIndex, 0, buildDequeuedUserMessage(threadId, orphaned));
      return { ...t, messages };
    }),
  );
}

function appendFallbackResultText(
  get: Get,
  set: Set,
  threadId: string,
  resultStatus: ThreadStatus,
  data: any,
): void {
  const resultText = resultStatus === 'completed' ? resultTextToAssistantMessage(data) : null;
  if (!resultText || !isHydrated(get(), threadId)) return;
  let appendedResultMessage = false;
  set((s) =>
    mutations.applyThreadDataPatch(s, threadId, (t) => {
      if (hasAssistantContentAfterLastUser(t.messages)) return t;
      appendedResultMessage = true;
      const role: MessageRole = 'assistant';
      const message = {
        id: crypto.randomUUID(),
        threadId,
        role,
        content: resultText,
        timestamp: new Date().toISOString(),
      };
      return { ...t, messages: [...t.messages, message] };
    }),
  );
  if (appendedResultMessage) {
    patchSidebarLastAssistant(threadId, resultText);
  }
}

function refreshProjectAfterResult(
  get: Get,
  threadId: string,
  foundInSidebar: boolean,
  loadThreadsForProject: (projectId: string) => Promise<void>,
): void {
  const payloadEntry = get().threadDataById[threadId];
  const projectIdForRefresh =
    payloadEntry && !isScratch(payloadEntry)
      ? payloadEntry.projectId
      : getProjectIdForThread(threadId);
  if (projectIdForRefresh) {
    setTimeout(() => loadThreadsForProject(projectIdForRefresh), 500);
  } else if (!foundInSidebar) {
    scheduleProjectRefresh(get);
  }
}

export function handleWSResult(get: Get, set: Set, threadId: string, data: any): void {
  // The server has spoken about this thread's status: an optimistic
  // `running` from a send is no longer something to undo.
  settlePreSendState(threadId);
  // Invalidate the cached snapshot unconditionally so the next selectThread()
  // refetches the final messages/tool calls/resultInfo from the server.
  invalidateThreadData(threadId);

  const state = get();
  const loadThreadsForProject = state.loadThreadsForProject;
  if (!isHydrated(state, threadId)) {
    maybeBuffer(state, threadId, 'result', data);
  }

  useThreadActiveToolStore.getState().clear(threadId);

  const machineEvent = wsEventToMachineEvent('agent:result', data);
  if (!machineEvent) {
    wsLog.warn('Invalid result event', {
      threadId,
      data: JSON.stringify(data).slice(0, 200),
    });
    return;
  }

  const serverStatus: ThreadStatus = data.status ?? 'completed';
  let resultStatus: ThreadStatus = serverStatus;
  wsLog.info('result processing', {
    threadId,
    serverStatus,
    cost: String(data.cost ?? ''),
    errorReason: data.errorReason ?? '',
    hydrated: String(isHydrated(state, threadId)),
  });

  const foundInSidebar = patchSidebarThread(threadId, (t) => {
    const newStatus = transitionThreadStatus(threadId, machineEvent, t.status, data.cost ?? t.cost);
    const nextStatus = newStatus !== t.status ? newStatus : serverStatus;
    resultStatus = nextStatus;
    return applyResultToRow(t, nextStatus, data);
  });
  const sidebarHitScratch = readThreadIndex().scratchThreadIds.includes(threadId);

  set(
    mutations.applyThreadDataPatch(state, threadId, (t) =>
      applyThreadPayloadResult(t, machineEvent, serverStatus, data, threadId),
    ),
  );

  flushOrphanedDequeuedMessage(get, set, threadId);
  appendFallbackResultText(get, set, threadId, resultStatus, data);

  if (
    (getUrlThreadId() ?? state.selectedThreadId) === threadId &&
    TERMINAL_READ_STATUSES.has(resultStatus)
  ) {
    useThreadReadStore.getState().markRead(threadId);
  }

  if (resultStatus === 'waiting') return;

  if (!sidebarHitScratch) {
    refreshProjectAfterResult(get, threadId, foundInSidebar, loadThreadsForProject);
  }

  if (!data.continuesAutomatically) {
    notifyThreadResult(threadId, resultStatus, get, data.errorReason);
  }
}

// ── Toast helper ────────────────────────────────────────────────

/** Toast messages, keyed by the agent's error reason. */
const ERROR_REASON_MESSAGES = new Map<string, string>(
  Object.entries({
    error_max_turns: 'Max turns reached — send a follow-up to continue',
    error_max_budget_usd: 'Budget limit exceeded',
    error_during_execution: 'Error during execution',
    provider_error: 'Provider error (rate limit or API error)',
  } satisfies Record<string, string>),
);

/**
 * A user who hides factory threads from the sidebar does not want to hear
 * each time one of their steps completes either. Failures still show.
 */
function isQuietFactoryCompletion(
  resultStatus: ThreadStatus,
  row: Thread | undefined,
  loaded: Thread | undefined,
): boolean {
  return (
    resultStatus === 'completed' &&
    useSidebarFilterStore.getState().hideFactoryThreads &&
    isFactoryThread(row ?? loaded)
  );
}

/** The title and project a result toast names and links to. */
function resultToastTarget(row: Thread | undefined, payload: Thread | undefined) {
  let threadTitle = 'Thread';
  let projectId: string | null = null;
  if (row) {
    threadTitle = row.title ?? threadTitle;
    // Scratch threads keep projectId = null, so downstream notification
    // routing falls through to a no-op rather than guessing.
    if (!isScratch(row)) projectId = row.projectId;
  }
  // Fallback: use the loaded payload if the thread wasn't found in sidebar data.
  if (threadTitle === 'Thread' && payload) {
    threadTitle = payload.title ?? threadTitle;
    projectId = projectId ?? payload.projectId;
  }
  return { threadTitle, projectId };
}

function notifyThreadResult(
  threadId: string,
  resultStatus: ThreadStatus,
  get: Get,
  errorReason?: string,
): void {
  // Look up the thread from the unified index. Project / scratch / unknown
  // all resolve uniformly. Falls back to the loaded payload for cases where
  // the thread was never loaded into the sidebar.
  const state = get();
  const row = readThreadRow(threadId);
  const payload = state.threadDataById[threadId];
  if (isQuietFactoryCompletion(resultStatus, row, payload)) return;
  const { threadTitle, projectId } = resultToastTarget(row, payload);

  const navigate = getNavigate();
  const navigateToThread = () => {
    if (projectId && navigate) {
      navigate(buildPath(`/projects/${projectId}/threads/${threadId}`));
      toast.dismiss(`result-${threadId}`);
    }
  };

  const toastOpts: Parameters<typeof toast.success>[1] = {
    id: `result-${threadId}`,
    action: { label: 'View', onClick: navigateToThread },
    duration: 4000,
  };
  const truncated = threadTitle.length > 20 ? threadTitle.slice(0, 20) + '…' : threadTitle;
  if (resultStatus === 'completed') {
    toast.success(`"${truncated}" completed`, toastOpts);
  } else if (resultStatus === 'failed') {
    const reason = errorReason
      ? (ERROR_REASON_MESSAGES.get(errorReason) ?? errorReason)
      : 'Unknown error';
    toast.error(`"${truncated}" failed: ${reason}`, {
      ...toastOpts,
      duration: 8000,
    });
  }
}
