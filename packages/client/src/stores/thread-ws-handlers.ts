/**
 * WebSocket event handlers for thread-store.
 * Each handler receives Zustand's get/set accessors plus the event payload.
 */

import { toast } from 'sonner';
import type { Thread, MessageRole, ThreadStatus } from '@a-parallel/shared';
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
  data: { messageId?: string; role: string; content: string }
): void {
  const { activeThread, selectedThreadId } = get();

  if (activeThread?.id === threadId) {
    const messageId = data.messageId;

    if (messageId) {
      const existingIdx = activeThread.messages.findIndex((m) => m.id === messageId);
      if (existingIdx >= 0) {
        const updated = [...activeThread.messages];
        updated[existingIdx] = { ...updated[existingIdx], content: data.content };
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
  data: { toolCallId?: string; messageId?: string; name: string; input: unknown }
): void {
  const { activeThread, selectedThreadId } = get();

  if (activeThread?.id === threadId) {
    const toolCallId = data.toolCallId || crypto.randomUUID();
    const messages = [...activeThread.messages];
    const tcEntry = { id: toolCallId, messageId: data.messageId || '', name: data.name, input: JSON.stringify(data.input) };

    if (messages.some(m => m.toolCalls?.some((tc: any) => tc.id === toolCallId))) return;

    if (data.messageId) {
      const msgIdx = messages.findIndex((m) => m.id === data.messageId);
      if (msgIdx >= 0) {
        const msg = messages[msgIdx];
        messages[msgIdx] = {
          ...msg,
          toolCalls: [...(msg.toolCalls ?? []), tcEntry],
        };
        set({ activeThread: { ...activeThread, messages } });
        return;
      }
    }

    set({
      activeThread: {
        ...activeThread,
        messages: [
          ...messages,
          {
            id: data.messageId || crypto.randomUUID(),
            threadId,
            role: 'assistant' as MessageRole,
            content: '',
            timestamp: new Date().toISOString(),
            toolCalls: [tcEntry],
          },
        ],
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

  const messages = activeThread.messages.map((msg) => {
    if (!msg.toolCalls) return msg;
    const updatedTCs = msg.toolCalls.map((tc: any) =>
      tc.id === data.toolCallId ? { ...tc, output: data.output } : tc
    );
    return { ...msg, toolCalls: updatedTCs };
  });

  set({ activeThread: { ...activeThread, messages } });
}

// ── Status ──────────────────────────────────────────────────────

export function handleWSStatus(
  get: Get, set: Set,
  threadId: string,
  data: { status: string }
): void {
  const { threadsByProject, activeThread, loadThreadsForProject } = get();

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
      if (newStatus !== t.status) {
        const copy = [...threads];
        copy[idx] = { ...t, status: newStatus };
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
    if (newStatus !== activeThread.status) {
      stateUpdate.activeThread = { ...activeThread, status: newStatus };
    }
  }

  if (Object.keys(stateUpdate).length > 0) {
    set(stateUpdate as any);
  }

  if (!foundInSidebar && activeThread?.id === threadId) {
    loadThreadsForProject(activeThread.projectId);
  }
}

// ── Result ──────────────────────────────────────────────────────

export function handleWSResult(
  get: Get, set: Set,
  threadId: string,
  data: any
): void {
  const { threadsByProject, activeThread, loadThreadsForProject } = get();

  const machineEvent = wsEventToMachineEvent('agent:result', data);
  if (!machineEvent) {
    console.warn(`[thread-store] Invalid result event for thread ${threadId}:`, data);
    return;
  }

  let resultStatus: ThreadStatus = data.status ?? 'completed';
  let foundInSidebar = false;
  let updatedProject: { pid: string; threads: Thread[] } | null = null;

  for (const [pid, threads] of Object.entries(threadsByProject)) {
    const idx = threads.findIndex((t) => t.id === threadId);
    if (idx >= 0) {
      foundInSidebar = true;
      const t = threads[idx];
      const newStatus = transitionThreadStatus(threadId, machineEvent, t.status, data.cost ?? t.cost);
      resultStatus = newStatus;
      const copy = [...threads];
      copy[idx] = { ...t, status: newStatus, cost: data.cost ?? t.cost };
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
        },
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
  }

  // Toast notification
  notifyThreadResult(threadId, resultStatus, updatedProject);
}

// ── Toast helper ────────────────────────────────────────────────

function notifyThreadResult(
  threadId: string,
  resultStatus: ThreadStatus,
  updatedProject: { pid: string; threads: Thread[] } | null
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
    duration: 2000,
  };
  if (resultStatus === 'completed') {
    toast.success(`"${threadTitle}" completed`, toastOpts);
  } else if (resultStatus === 'failed') {
    toast.error(`"${threadTitle}" failed`, toastOpts);
  }
}
