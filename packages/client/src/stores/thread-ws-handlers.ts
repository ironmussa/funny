/**
 * WebSocket event handlers for thread-store.
 * Each handler receives Zustand's get/set accessors plus the event payload.
 */

import { toast } from 'sonner';
import type { Thread, MessageRole, ThreadStatus } from '@funny/shared';
import { bufferWSEvent, getNavigate } from './thread-store-internals';
import { transitionThreadStatus, getThreadActor, wsEventToMachineEvent } from './thread-machine-bridge';
import type { AgentInitInfo, ThreadState } from './thread-store';

type Get = () => ThreadState;
type Set = (partial: Partial<ThreadState> | ((state: ThreadState) => Partial<ThreadState>)) => void;

// ── Init ────────────────────────────────────────────────────────

export function handleWSInit(get: Get, set: Set, threadId: string, data: AgentInitInfo): void {
  const { activeThread } = get();
  if (activeThread?.id === threadId) {
    set({ activeThread: { ...activeThread, initInfo: data } });
  }
  // If not active, thread-store-internals will buffer it via setBufferedInitInfo
  // (caller handles this since it needs the initInfoBuffer from internals)
}

// ── Message ─────────────────────────────────────────────────────

export function handleWSMessage(
  get: Get, set: Set,
  threadId: string,
  data: { messageId?: string; role: string; content: string; author?: string }
): void {
  const { activeThread, selectedThreadId } = get();

  if (activeThread?.id === threadId) {
    const messageId = data.messageId;

    if (messageId) {
      const existingIdx = activeThread.messages.findIndex((m) => m.id === messageId);
      if (existingIdx >= 0) {
        const updated = [...activeThread.messages];
        updated[existingIdx] = { ...updated[existingIdx], content: data.content, ...(data.author ? { author: data.author } : {}) };
        set({ activeThread: { ...activeThread, messages: updated } });
        return;
      }
    }

    set({
      activeThread: {
        ...activeThread,
        messages: [
          ...activeThread.messages,
          {
            id: messageId || crypto.randomUUID(),
            threadId,
            role: data.role as MessageRole,
            content: data.content,
            timestamp: new Date().toISOString(),
            ...(data.author ? { author: data.author } : {}),
          },
        ],
      },
    });
  } else if (selectedThreadId === threadId) {
    bufferWSEvent(threadId, 'message', data);
  }
}

// ── Tool Call ───────────────────────────────────────────────────

export function handleWSToolCall(
  get: Get, set: Set,
  threadId: string,
  data: { toolCallId?: string; messageId?: string; name: string; input: unknown; author?: string }
): void {
  const { activeThread, selectedThreadId } = get();

  if (activeThread?.id === threadId) {
    const toolCallId = data.toolCallId || crypto.randomUUID();
    const tcEntry = { id: toolCallId, messageId: data.messageId || '', name: data.name, input: JSON.stringify(data.input), ...(data.author ? { author: data.author } : {}) };

    if (activeThread.messages.some(m => m.toolCalls?.some((tc: any) => tc.id === toolCallId))) return;

    if (data.messageId) {
      const msgIdx = activeThread.messages.findIndex((m) => m.id === data.messageId);
      if (msgIdx >= 0) {
        const messages = activeThread.messages.slice();
        const msg = messages[msgIdx];
        messages[msgIdx] = {
          ...msg,
          toolCalls: (msg.toolCalls ?? []).concat(tcEntry),
        };
        set({ activeThread: { ...activeThread, messages } });
        return;
      }
    }

    set({
      activeThread: {
        ...activeThread,
        messages: activeThread.messages.concat({
          id: data.messageId || crypto.randomUUID(),
          threadId,
          role: 'assistant' as MessageRole,
          content: '',
          timestamp: new Date().toISOString(),
          toolCalls: [tcEntry],
        }),
      },
    });
  } else if (selectedThreadId === threadId) {
    bufferWSEvent(threadId, 'tool_call', data);
  }
}

// ── Tool Output ─────────────────────────────────────────────────

export function handleWSToolOutput(
  get: Get, set: Set,
  threadId: string,
  data: { toolCallId: string; output: string }
): void {
  const { activeThread, selectedThreadId } = get();
  if (activeThread?.id !== threadId) {
    if (selectedThreadId === threadId) bufferWSEvent(threadId, 'tool_output', data);
    return;
  }

  // Only rebuild the specific message containing the tool call, not the entire array
  let changed = false;
  const messages = activeThread.messages.map((msg) => {
    if (!msg.toolCalls) return msg;
    const tcIdx = msg.toolCalls.findIndex((tc: any) => tc.id === data.toolCallId);
    if (tcIdx < 0) return msg; // unchanged — same reference
    changed = true;
    const updatedTCs = [...msg.toolCalls];
    updatedTCs[tcIdx] = { ...updatedTCs[tcIdx], output: data.output };
    return { ...msg, toolCalls: updatedTCs };
  });

  if (changed) {
    set({ activeThread: { ...activeThread, messages } });
  }
}

// ── Status ──────────────────────────────────────────────────────

export function handleWSStatus(
  get: Get, set: Set,
  threadId: string,
  data: { status: string; waitingReason?: string; permissionRequest?: { toolName: string }; stage?: string; permissionMode?: string }
): void {
  const { threadsByProject, activeThread, loadThreadsForProject, selectedThreadId } = get();

  // Buffer status events when thread is selected but not yet fully loaded
  if (!activeThread?.id || activeThread.id !== threadId) {
    if (selectedThreadId === threadId) {
      bufferWSEvent(threadId, 'status', data);
    }
  }

  const machineEvent = wsEventToMachineEvent('agent:status', data);
  if (!machineEvent) {
    console.warn(`[thread-store] Invalid status transition for thread ${threadId}:`, data.status);
    return;
  }

  let foundInSidebar = false;
  let updatedProject: { pid: string; threads: Thread[] } | null = null;

  for (const [pid, threads] of Object.entries(threadsByProject)) {
    const idx = threads.findIndex((t) => t.id === threadId);
    if (idx >= 0) {
      foundInSidebar = true;
      const t = threads[idx];
      const newStatus = transitionThreadStatus(threadId, machineEvent, t.status, t.cost);
      if (newStatus !== t.status || (data.stage && data.stage !== t.stage) || (data.permissionMode && data.permissionMode !== t.permissionMode)) {
        const copy = [...threads];
        copy[idx] = { ...t, status: newStatus, ...(data.stage ? { stage: data.stage as any } : {}), ...(data.permissionMode ? { permissionMode: data.permissionMode as any } : {}) };
        updatedProject = { pid, threads: copy };
      }
      break;
    }
  }

  const stateUpdate: Partial<ThreadState> = {};

  if (updatedProject) {
    stateUpdate.threadsByProject = { ...threadsByProject, [updatedProject.pid]: updatedProject.threads };
  }

  if (activeThread?.id === threadId) {
    const newStatus = transitionThreadStatus(threadId, machineEvent, activeThread.status, activeThread.cost);
    if (newStatus !== activeThread.status || (data.stage && data.stage !== activeThread.stage) || (data.permissionMode && data.permissionMode !== activeThread.permissionMode)) {
      // If transitioning to waiting, include waitingReason and permissionRequest
      if (newStatus === 'waiting') {
        stateUpdate.activeThread = {
          ...activeThread,
          status: newStatus,
          waitingReason: data.waitingReason as any,
          pendingPermission: data.permissionRequest,
          ...(data.stage ? { stage: data.stage as any } : {}),
          ...(data.permissionMode ? { permissionMode: data.permissionMode as any } : {}),
        };
      } else {
        stateUpdate.activeThread = {
          ...activeThread,
          status: newStatus,
          waitingReason: undefined,
          pendingPermission: undefined,
          ...(newStatus === 'stopped' || newStatus === 'interrupted' ? { resultInfo: undefined } : {}),
          ...(data.stage ? { stage: data.stage as any } : {}),
          ...(data.permissionMode ? { permissionMode: data.permissionMode as any } : {}),
        };
      }
    }
  }

  if (Object.keys(stateUpdate).length > 0) {
    set(stateUpdate as any);
  }

  if (!foundInSidebar) {
    if (activeThread?.id === threadId) {
      loadThreadsForProject(activeThread.projectId);
    } else {
      // Thread not found in any loaded project — likely created externally
      // (e.g. Chrome extension ingest). Refresh all loaded projects.
      for (const pid of Object.keys(threadsByProject)) {
        loadThreadsForProject(pid);
      }
    }
  }
}

// ── Result ──────────────────────────────────────────────────────

export function handleWSResult(
  get: Get, set: Set,
  threadId: string,
  data: any
): void {
  const { threadsByProject, activeThread, loadThreadsForProject, selectedThreadId } = get();

  // Buffer result events when thread is selected but not yet fully loaded
  if (!activeThread?.id || activeThread.id !== threadId) {
    if (selectedThreadId === threadId) {
      bufferWSEvent(threadId, 'result', data);
    }
  }

  const machineEvent = wsEventToMachineEvent('agent:result', data);
  if (!machineEvent) {
    console.warn(`[thread-store] Invalid result event for thread ${threadId}:`, data);
    return;
  }

  const serverStatus: ThreadStatus = data.status ?? 'completed';
  let resultStatus: ThreadStatus = serverStatus;
  let foundInSidebar = false;
  let updatedProject: { pid: string; threads: Thread[] } | null = null;

  for (const [pid, threads] of Object.entries(threadsByProject)) {
    const idx = threads.findIndex((t) => t.id === threadId);
    if (idx >= 0) {
      foundInSidebar = true;
      const t = threads[idx];
      const newStatus = transitionThreadStatus(threadId, machineEvent, t.status, data.cost ?? t.cost);
      // Use server status as authoritative if xstate transition didn't change state
      // (e.g., actor was in stale state that didn't accept the event)
      resultStatus = newStatus !== t.status ? newStatus : serverStatus;
      const copy = [...threads];
      copy[idx] = { ...t, status: resultStatus, cost: data.cost ?? t.cost, ...(data.stage ? { stage: data.stage } : {}) };
      updatedProject = { pid, threads: copy };
      break;
    }
  }

  const stateUpdate: Partial<ThreadState> = {};
  if (updatedProject) {
    stateUpdate.threadsByProject = { ...threadsByProject, [updatedProject.pid]: updatedProject.threads };
  }

  if (activeThread?.id === threadId) {
    const isWaiting = resultStatus === 'waiting';

    if (isWaiting) {
      stateUpdate.activeThread = {
        ...activeThread,
        status: resultStatus,
        cost: data.cost ?? activeThread.cost,
        waitingReason: data.waitingReason,
        pendingPermission: data.permissionRequest,
        ...(data.stage ? { stage: data.stage } : {}),
      };
    } else {
      const actor = getThreadActor(threadId, activeThread.status, activeThread.cost);
      const snapshot = actor.getSnapshot();

      stateUpdate.activeThread = {
        ...activeThread,
        status: resultStatus,
        cost: data.cost ?? activeThread.cost,
        waitingReason: undefined,
        pendingPermission: undefined,
        resultInfo: snapshot.context.resultInfo ?? {
          status: resultStatus as 'completed' | 'failed',
          cost: data.cost ?? activeThread.cost,
          duration: data.duration ?? 0,
          error: data.error,
        },
        ...(data.stage ? { stage: data.stage } : {}),
      };
    }
  }

  set(stateUpdate as any);

  if (resultStatus === 'waiting') return;

  const projectIdForRefresh = activeThread?.id === threadId
    ? activeThread.projectId
    : Object.keys(threadsByProject).find((pid) =>
        threadsByProject[pid]?.some((t) => t.id === threadId)
      );

  if (projectIdForRefresh) {
    setTimeout(() => loadThreadsForProject(projectIdForRefresh), 500);
  } else {
    // Thread not found in any loaded project — likely created externally
    // (e.g. Chrome extension ingest). Refresh all loaded projects so it appears.
    for (const pid of Object.keys(threadsByProject)) {
      loadThreadsForProject(pid);
    }
  }

  // Toast notification
  notifyThreadResult(threadId, resultStatus, updatedProject, get, data.errorReason);
}

// ── Queue update ─────────────────────────────────────────────────

export function handleWSQueueUpdate(
  get: Get, set: Set,
  threadId: string,
  data: { threadId: string; queuedCount: number; nextMessage?: string },
): void {
  const { activeThread } = get();

  if (activeThread?.id === threadId) {
    set({
      activeThread: {
        ...activeThread,
        queuedCount: data.queuedCount,
        queuedNextMessage: data.nextMessage,
      },
    } as any);
  }
}

// ── Toast helper ────────────────────────────────────────────────

const ERROR_REASON_MESSAGES: Record<string, string> = {
  error_max_turns: 'Max turns reached — send a follow-up to continue',
  error_max_budget_usd: 'Budget limit exceeded',
  error_during_execution: 'Error during execution',
};

function notifyThreadResult(
  threadId: string,
  resultStatus: ThreadStatus,
  updatedProject: { pid: string; threads: Thread[] } | null,
  get: Get,
  errorReason?: string
): void {
  let threadTitle = 'Thread';
  let projectId: string | null = null;
  if (updatedProject) {
    const found = updatedProject.threads.find((t) => t.id === threadId);
    if (found) {
      threadTitle = found.title ?? threadTitle;
      projectId = updatedProject.pid;
    }
  }

  // Fallback: use activeThread if the thread wasn't found in sidebar data
  if (threadTitle === 'Thread') {
    const { activeThread } = get();
    if (activeThread?.id === threadId) {
      threadTitle = activeThread.title ?? threadTitle;
      projectId = projectId ?? activeThread.projectId;
    }
  }

  const navigate = getNavigate();
  const navigateToThread = () => {
    if (projectId && navigate) {
      navigate(`/projects/${projectId}/threads/${threadId}`);
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
    const reason = errorReason ? ERROR_REASON_MESSAGES[errorReason] ?? errorReason : 'Unknown error';
    toast.error(`"${truncated}" failed: ${reason}`, { ...toastOpts, duration: 8000 });
  }
}
