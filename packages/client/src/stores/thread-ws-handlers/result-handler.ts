/** `agent:result`, and the toast that reports how the run ended. */

import type { MessageRole, Thread, ThreadStatus } from '@funny/shared';
import { toast } from 'sonner';

import { readThreadIndex, readThreadRow } from '@/data/threads/read';
import { isScratch } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';

import { settlePreSendState } from '../optimistic-run-state';
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

export function handleWSResult(get: Get, set: Set, threadId: string, data: any): void {
  // The server has spoken about this thread's status: an optimistic
  // `running` from a send is no longer something to undo.
  settlePreSendState(threadId);
  // Invalidate the cached snapshot unconditionally so the next selectThread()
  // refetches the final messages/tool calls/resultInfo from the server. Must
  // run even for the active thread — otherwise the user switches away, comes
  // back, and the data-actor returns the stale pre-completion snapshot,
  // making the thread look as if it never finished.
  invalidateThreadData(threadId);

  const state = get();
  const loadThreadsForProject = state.loadThreadsForProject;
  if (!isHydrated(state, threadId)) {
    maybeBuffer(state, threadId, 'result', data);
    // Sidebar status still applied below.
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

  // Apply the result transition to whichever sidebar bucket holds the thread.
  // The updater closes over `resultStatus` to also expose the resolved status
  // back to the caller for the toast/notification + payload paths.
  const foundInSidebar = patchSidebarThread(threadId, (t) => {
    const newStatus = transitionThreadStatus(threadId, machineEvent, t.status, data.cost ?? t.cost);
    // The server's result is authoritative: when the machine has no
    // transition for it from the row's status, take the server status as is.
    const nextStatus = newStatus !== t.status ? newStatus : serverStatus;
    resultStatus = nextStatus;
    return applyResultToRow(t, nextStatus, data);
  });
  // Scratch threads sit outside any project, so the post-result fallback
  // (`loadThreadsForProject` / `scheduleProjectRefresh`) should be skipped.
  const sidebarHitScratch = readThreadIndex().scratchThreadIds.includes(threadId);

  const payloadPatch = mutations.applyThreadDataPatch(state, threadId, (t) => {
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
        status: finalStatus as 'completed' | 'failed',
        cost: data.cost ?? t.cost,
        duration: data.duration ?? 0,
        error: data.error,
      },
      stage: data.stage ? data.stage : t.stage,
    };
  });

  set(payloadPatch as any);

  // Flush any orphaned dequeued message for this thread. The buffer is set by
  // a `queue:update` event between the previous turn's result and the next
  // turn's first agent:message — but if the next agent fails before emitting
  // any message, the buffer leaks and would inject into a future, unrelated
  // turn. Inject it now as a user message so the user sees what was dequeued,
  // and clear the buffer so it can't contaminate later. Skip injection if the
  // payload already ends with a matching user message (bug 4 — duplicate when
  // the server-inserted message is already loaded).
  const orphaned = pendingDequeuedMessages.get(threadId);
  if (orphaned) {
    pendingDequeuedMessages.delete(threadId);
    if (isHydrated(get(), threadId)) {
      set((s) =>
        mutations.applyThreadDataPatch(s, threadId, (t) => {
          if (dequeuedUserAlreadyShownInTurn(t.messages, orphaned.content)) return t;
          const insertionIndex = trailingAssistantScaffoldStart(t.messages);
          const messages = t.messages.slice();
          messages.splice(insertionIndex, 0, buildDequeuedUserMessage(threadId, orphaned));
          return {
            ...t,
            messages,
          };
        }),
      );
    }
  }

  const resultText = resultStatus === 'completed' ? resultTextToAssistantMessage(data) : null;
  if (resultText && isHydrated(get(), threadId)) {
    let appendedResultMessage = false;
    set((s) =>
      mutations.applyThreadDataPatch(s, threadId, (t) => {
        if (hasAssistantContentAfterLastUser(t.messages)) return t;
        appendedResultMessage = true;
        const message = {
          id: crypto.randomUUID(),
          threadId,
          role: 'assistant' as MessageRole,
          content: resultText,
          timestamp: new Date().toISOString(),
        };
        return {
          ...t,
          messages: [...t.messages, message],
        };
      }),
    );

    if (appendedResultMessage) {
      patchSidebarLastAssistant(threadId, resultText);
    }
  }

  // If the thread the user is currently viewing just finished, mark it as read
  // so it doesn't show an unread blue dot in the sidebar.
  if (
    (getUrlThreadId() ?? state.selectedThreadId) === threadId &&
    (resultStatus === 'completed' ||
      resultStatus === 'failed' ||
      resultStatus === 'stopped' ||
      resultStatus === 'interrupted')
  ) {
    useThreadReadStore.getState().markRead(threadId);
  }

  if (resultStatus === 'waiting') return;

  // Skip the project-refresh fallback when the thread is scratch — we already
  // patched scratchThreads above, and scratch threads have no project so a
  // bare scheduleProjectRefresh() would just storm every loaded project.
  if (sidebarHitScratch) {
    notifyThreadResult(threadId, resultStatus, get, data.errorReason);
    return;
  }

  const payloadEntry = get().threadDataById[threadId];
  const projectIdForRefresh =
    payloadEntry && !isScratch(payloadEntry)
      ? payloadEntry.projectId
      : getProjectIdForThread(threadId);

  if (projectIdForRefresh) {
    setTimeout(() => loadThreadsForProject(projectIdForRefresh), 500);
  } else if (foundInSidebar) {
    // Thread is in the sidebar but we don't know its project (shouldn't
    // happen for project threads — defensive). Skip the global refresh.
  } else {
    // Thread not found in any loaded project — likely created externally
    // (e.g. Chrome extension ingest). Debounce refresh to avoid API storm.
    scheduleProjectRefresh(get);
  }

  // Toast notification
  notifyThreadResult(threadId, resultStatus, get, data.errorReason);
}

// ── Toast helper ────────────────────────────────────────────────

/** Toast messages, keyed by the agent's error reason. */
interface ErrorReasonMessages {
  [reason: string]: string;
}

const ERROR_REASON_MESSAGES: ErrorReasonMessages = {
  error_max_turns: 'Max turns reached — send a follow-up to continue',
  error_max_budget_usd: 'Budget limit exceeded',
  error_during_execution: 'Error during execution',
  provider_error: 'Provider error (rate limit or API error)',
};

function notifyThreadResult(
  threadId: string,
  resultStatus: ThreadStatus,
  get: Get,
  errorReason?: string,
): void {
  let threadTitle = 'Thread';
  let projectId: string | null = null;

  // Look up the thread from the unified index. Project / scratch / unknown
  // all resolve uniformly. Falls back to the loaded payload below for cases
  // where the thread was never loaded into the sidebar.
  const state = get();
  const t = readThreadRow(threadId);
  if (t) {
    threadTitle = t.title ?? threadTitle;
    // Scratch threads keep projectId = null, so downstream notification
    // routing falls through to a no-op rather than guessing.
    if (!isScratch(t)) projectId = t.projectId;
  }

  // Fallback: use the loaded payload if the thread wasn't found in sidebar data.
  if (threadTitle === 'Thread') {
    const payload = state.threadDataById[threadId];
    if (payload) {
      threadTitle = payload.title ?? threadTitle;
      projectId = projectId ?? payload.projectId;
    }
  }

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
      ? (ERROR_REASON_MESSAGES[errorReason] ?? errorReason)
      : 'Unknown error';
    toast.error(`"${truncated}" failed: ${reason}`, {
      ...toastOpts,
      duration: 8000,
    });
  }
}
