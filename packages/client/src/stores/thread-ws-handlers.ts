/**
 * WebSocket event handlers for thread-store.
 * Each handler receives Zustand's get/set accessors plus the event payload.
 */

import type { Thread, MessageRole, ThreadStatus, ImageAttachment } from '@funny/shared';
import { toast } from 'sonner';

import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';

import {
  transitionThreadStatus,
  getThreadActor,
  wsEventToMachineEvent,
} from './thread-machine-bridge';
import type { AgentInitInfo, ThreadState } from './thread-store';
import { bufferWSEvent, getNavigate } from './thread-store-internals';

const wsLog = createClientLogger('ws-handlers');

type Get = () => ThreadState;
type Set = (partial: Partial<ThreadState> | ((state: ThreadState) => Partial<ThreadState>)) => void;

// Buffer for dequeued user messages — injected when the next agent:message
// arrives so the user message appears right before the new agent's response.
// We use handleWSMessage (called synchronously during flush) rather than
// handleWSInit (deferred via startTransition) to guarantee correct ordering.
interface DequeuedMessageBuffer {
  content: string;
  images?: ImageAttachment[];
}
const pendingDequeuedMessages = new Map<string, DequeuedMessageBuffer>();

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
  get: Get,
  set: Set,
  threadId: string,
  data: { messageId?: string; role: string; content: string; author?: string },
): void {
  const { activeThread, selectedThreadId } = get();

  if (activeThread?.id === threadId) {
    const messageId = data.messageId;

    if (messageId) {
      const existingIdx = activeThread.messages.findIndex((m) => m.id === messageId);
      if (existingIdx >= 0) {
        const updated = [...activeThread.messages];
        updated[existingIdx] = {
          ...updated[existingIdx],
          content: data.content,
          ...(data.author ? { author: data.author } : {}),
        };
        set({ activeThread: { ...activeThread, messages: updated } });
        return;
      }
    }

    // If there's a buffered dequeued user message, prepend it before this
    // assistant message so the user message appears in the correct position
    const dequeuedMsg = pendingDequeuedMessages.get(threadId);
    const extraMessages: typeof activeThread.messages = [];
    if (dequeuedMsg) {
      pendingDequeuedMessages.delete(threadId);
      extraMessages.push({
        id: crypto.randomUUID(),
        threadId,
        role: 'user' as MessageRole,
        content: dequeuedMsg.content,
        images: dequeuedMsg.images,
        timestamp: new Date().toISOString(),
      });
    }

    const newMsg = {
      id: messageId || crypto.randomUUID(),
      threadId,
      role: data.role as MessageRole,
      content: data.content,
      timestamp: new Date().toISOString(),
      ...(data.author ? { author: data.author } : {}),
    };

    // Update lastUserMessage when a dequeued user message or user-role WS message arrives
    const lastUserMessage =
      extraMessages.length > 0
        ? extraMessages[extraMessages.length - 1]
        : data.role === 'user'
          ? newMsg
          : activeThread.lastUserMessage;

    set({
      activeThread: {
        ...activeThread,
        lastUserMessage,
        messages: [...activeThread.messages, ...extraMessages, newMsg],
      },
    });
  } else if (selectedThreadId === threadId) {
    bufferWSEvent(threadId, 'message', data);
  }

  // Update sidebar snippet for assistant messages
  if (data.role === 'assistant' && data.content) {
    const { threadsByProject } = get();
    const snippet = data.content.slice(0, 120);
    for (const [pid, threads] of Object.entries(threadsByProject)) {
      const idx = threads.findIndex((t) => t.id === threadId);
      if (idx >= 0) {
        const updated = [...threads];
        updated[idx] = { ...updated[idx], lastAssistantMessage: snippet };
        set({
          threadsByProject: { ...threadsByProject, [pid]: updated },
        });
        break;
      }
    }
  }
}

// ── Tool Call ───────────────────────────────────────────────────

export function handleWSToolCall(
  get: Get,
  set: Set,
  threadId: string,
  data: { toolCallId?: string; messageId?: string; name: string; input: unknown; author?: string },
): void {
  const { activeThread, selectedThreadId } = get();

  if (activeThread?.id === threadId) {
    const toolCallId = data.toolCallId || crypto.randomUUID();
    const tcEntry = {
      id: toolCallId,
      messageId: data.messageId || '',
      name: data.name,
      input: JSON.stringify(data.input),
      ...(data.author ? { author: data.author } : {}),
    };

    if (activeThread.messages.some((m) => m.toolCalls?.some((tc: any) => tc.id === toolCallId)))
      return;

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
  get: Get,
  set: Set,
  threadId: string,
  data: { toolCallId: string; output: string },
): void {
  const { activeThread, selectedThreadId } = get();
  if (activeThread?.id !== threadId) {
    if (selectedThreadId === threadId) bufferWSEvent(threadId, 'tool_output', data);
    return;
  }

  // Find and update only the specific message containing the tool call.
  // Avoid .map() which creates a new array reference even when nothing changed.
  for (let i = 0; i < activeThread.messages.length; i++) {
    const msg = activeThread.messages[i];
    if (!msg.toolCalls) continue;
    const tcIdx = msg.toolCalls.findIndex((tc: any) => tc.id === data.toolCallId);
    if (tcIdx < 0) continue;
    // Found — create a shallow copy of the messages array with only this message replaced
    const messages = activeThread.messages.slice();
    const updatedTCs = [...msg.toolCalls];
    updatedTCs[tcIdx] = { ...updatedTCs[tcIdx], output: data.output };
    messages[i] = { ...msg, toolCalls: updatedTCs };
    set({ activeThread: { ...activeThread, messages } });
    return;
  }
}

// ── Status ──────────────────────────────────────────────────────

export function handleWSStatus(
  get: Get,
  set: Set,
  threadId: string,
  data: {
    status: string;
    waitingReason?: string;
    permissionRequest?: { toolName: string };
    stage?: string;
    permissionMode?: string;
  },
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
    wsLog.warn('Invalid status transition', { threadId, status: data.status });
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
      wsLog.debug('status transition', {
        threadId,
        from: t.status,
        to: newStatus,
        waitingReason: data.waitingReason ?? '',
      });
      if (
        newStatus !== t.status ||
        (data.stage && data.stage !== t.stage) ||
        (data.permissionMode && data.permissionMode !== t.permissionMode)
      ) {
        const copy = [...threads];
        copy[idx] = {
          ...t,
          status: newStatus,
          ...(data.stage ? { stage: data.stage as any } : {}),
          ...(data.permissionMode ? { permissionMode: data.permissionMode as any } : {}),
        };
        updatedProject = { pid, threads: copy };
      }
      break;
    }
  }

  const stateUpdate: Partial<ThreadState> = {};

  if (updatedProject) {
    stateUpdate.threadsByProject = {
      ...threadsByProject,
      [updatedProject.pid]: updatedProject.threads,
    };
  }

  if (activeThread?.id === threadId) {
    const newStatus = transitionThreadStatus(
      threadId,
      machineEvent,
      activeThread.status,
      activeThread.cost,
    );
    if (
      newStatus !== activeThread.status ||
      (data.stage && data.stage !== activeThread.stage) ||
      (data.permissionMode && data.permissionMode !== activeThread.permissionMode)
    ) {
      // If transitioning to waiting, include waitingReason and permissionRequest
      if (newStatus === 'waiting' && !data.waitingReason) {
        wsLog.warn('BUG-HUNT: agent:status waiting but NO waitingReason', {
          threadId,
          dataStatus: data.status,
        });
      }
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
          ...(newStatus === 'stopped' || newStatus === 'interrupted'
            ? { resultInfo: undefined }
            : {}),
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

export function handleWSResult(get: Get, set: Set, threadId: string, data: any): void {
  const { threadsByProject, activeThread, loadThreadsForProject, selectedThreadId } = get();

  // Buffer result events when thread is selected but not yet fully loaded
  if (!activeThread?.id || activeThread.id !== threadId) {
    if (selectedThreadId === threadId) {
      bufferWSEvent(threadId, 'result', data);
    }
  }

  const machineEvent = wsEventToMachineEvent('agent:result', data);
  if (!machineEvent) {
    wsLog.warn('Invalid result event', { threadId, data: JSON.stringify(data).slice(0, 200) });
    return;
  }

  const serverStatus: ThreadStatus = data.status ?? 'completed';
  let resultStatus: ThreadStatus = serverStatus;
  wsLog.info('result processing', {
    threadId,
    serverStatus,
    cost: String(data.cost ?? ''),
    errorReason: data.errorReason ?? '',
  });
  let updatedProject: { pid: string; threads: Thread[] } | null = null;

  for (const [pid, threads] of Object.entries(threadsByProject)) {
    const idx = threads.findIndex((t) => t.id === threadId);
    if (idx >= 0) {
      const t = threads[idx];
      const newStatus = transitionThreadStatus(
        threadId,
        machineEvent,
        t.status,
        data.cost ?? t.cost,
      );
      // Use server status as authoritative if xstate transition didn't change state
      // (e.g., actor was in stale state that didn't accept the event)
      resultStatus = newStatus !== t.status ? newStatus : serverStatus;
      const copy = [...threads];
      copy[idx] = {
        ...t,
        status: resultStatus,
        cost: data.cost ?? t.cost,
        ...(data.stage ? { stage: data.stage } : {}),
      };
      updatedProject = { pid, threads: copy };
      break;
    }
  }

  const stateUpdate: Partial<ThreadState> = {};
  if (updatedProject) {
    stateUpdate.threadsByProject = {
      ...threadsByProject,
      [updatedProject.pid]: updatedProject.threads,
    };
  }

  if (activeThread?.id === threadId) {
    const isWaiting = resultStatus === 'waiting';

    if (isWaiting) {
      if (!data.waitingReason) {
        wsLog.warn(
          'BUG-HUNT: agent:result waiting but NO waitingReason — will show generic WaitingActions instead of question/plan card',
          { threadId },
        );
      }
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

  const projectIdForRefresh =
    activeThread?.id === threadId
      ? activeThread.projectId
      : Object.keys(threadsByProject).find((pid) =>
          threadsByProject[pid]?.some((t) => t.id === threadId),
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
  get: Get,
  set: Set,
  threadId: string,
  data: {
    threadId: string;
    queuedCount: number;
    nextMessage?: string;
    dequeuedMessage?: string;
    dequeuedImages?: ImageAttachment[];
  },
): void {
  const { activeThread } = get();

  // Buffer dequeued message — will be injected on next agent:init to ensure
  // it appears after the previous agent's response (correct visual ordering)
  if (data.dequeuedMessage) {
    pendingDequeuedMessages.set(threadId, {
      content: data.dequeuedMessage,
      images: data.dequeuedImages,
    });
  }

  if (activeThread?.id === threadId) {
    wsLog.info('handleWSQueueUpdate: setting queuedCount on activeThread', {
      threadId,
      queuedCount: String(data.queuedCount),
      nextMessage: data.nextMessage?.slice(0, 50) ?? 'none',
      prevQueuedCount: String((activeThread as any).queuedCount ?? 'undefined'),
    });
    set({
      activeThread: {
        ...activeThread,
        queuedCount: data.queuedCount,
        queuedNextMessage: data.nextMessage,
      },
    } as any);
  } else {
    wsLog.warn('handleWSQueueUpdate: activeThread mismatch — event dropped', {
      threadId,
      activeThreadId: activeThread?.id ?? 'null',
      queuedCount: String(data.queuedCount),
    });
  }
}

// ── Compact boundary ────────────────────────────────────────────

export function handleWSCompactBoundary(
  get: Get,
  set: Set,
  threadId: string,
  data: { trigger: 'manual' | 'auto'; preTokens: number; timestamp: string },
): void {
  const { activeThread, selectedThreadId } = get();
  if (activeThread?.id !== threadId) {
    if (selectedThreadId === threadId) bufferWSEvent(threadId, 'compact_boundary', data);
    return;
  }

  set({
    activeThread: {
      ...activeThread,
      compactionEvents: [...(activeThread.compactionEvents ?? []), data],
      // After compaction, the next assistant message's input_tokens will
      // naturally reflect the post-compaction context size — no reset needed.
    },
  });
}

// ── Context usage ───────────────────────────────────────────────

export function handleWSContextUsage(
  get: Get,
  set: Set,
  threadId: string,
  data: { inputTokens: number; outputTokens: number; cumulativeInputTokens: number },
): void {
  const { activeThread, selectedThreadId, contextUsageByThread } = get();
  const usage = {
    cumulativeInputTokens: data.cumulativeInputTokens,
    lastInputTokens: data.inputTokens,
    lastOutputTokens: data.outputTokens,
  };

  // Always persist to the map so it survives thread switches
  const updates: Partial<import('./thread-store').ThreadState> = {
    contextUsageByThread: { ...contextUsageByThread, [threadId]: usage },
  };

  if (activeThread?.id === threadId) {
    updates.activeThread = { ...activeThread, contextUsage: usage };
  } else if (selectedThreadId === threadId) {
    bufferWSEvent(threadId, 'context_usage', data);
  }

  set(updates as any);
}

// ── Error ────────────────────────────────────────────────────────

/**
 * Handle agent:error WS events. Unlike handleWSStatus (which only sets
 * status to 'failed'), this stores the error message in resultInfo so
 * AgentResultCard can display it, and shows a toast immediately.
 */
export function handleWSError(
  get: Get,
  set: Set,
  threadId: string,
  data: { error?: string },
): void {
  const errorMessage = data.error ?? 'Unknown error';

  // Delegate status transition to the existing handler (updates sidebar + activeThread)
  handleWSStatus(get, set, threadId, { status: 'failed' });

  // Now enrich the activeThread with resultInfo so AgentResultCard renders the error
  const { activeThread } = get();
  if (activeThread?.id === threadId) {
    set({
      activeThread: {
        ...activeThread,
        ...get().activeThread, // pick up status changes from handleWSStatus
        resultInfo: activeThread.resultInfo ?? {
          status: 'failed' as const,
          cost: activeThread.cost ?? 0,
          duration: 0,
          error: errorMessage,
        },
      },
    });
  }

  // Show an immediate toast with the error
  toast.error(errorMessage, { duration: 8000 });
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
  errorReason?: string,
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
    toast.error(`"${truncated}" failed: ${reason}`, { ...toastOpts, duration: 8000 });
  }
}
