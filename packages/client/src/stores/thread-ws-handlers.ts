/**
 * WebSocket event handlers for thread-store.
 * Each handler receives Zustand's get/set accessors plus the event payload.
 */

import type { Thread, MessageRole, ThreadStatus, ImageAttachment } from '@funny/shared';
import { toast } from 'sonner';

import i18n from '@/i18n/config';
import { createClientLogger } from '@/lib/client-logger';
import { emitContextUsage } from '@/lib/context-usage-events';
import { buildPath } from '@/lib/url';

import {
  invalidateThreadData,
  transitionThreadStatus,
  wsEventToMachineEvent,
} from './thread-machine-bridge';
import { useThreadReadStore } from './thread-read-store';
import { bufferWSEvent, getNavigate, getProjectIdForThread } from './thread-store-internals';
import type { AgentInitInfo, ThreadState, ThreadWithMessages } from './thread-types';

const wsLog = createClientLogger('ws-handlers');

type Get = () => ThreadState;
type Set = (partial: Partial<ThreadState> | ((state: ThreadState) => Partial<ThreadState>)) => void;

// ── Live thread update helper ──────────────────────────────────
// Applies a mutation to a live-column thread if it's registered.
function updateLiveThread(
  get: Get,
  set: Set,
  threadId: string,
  updater: (thread: ThreadWithMessages) => ThreadWithMessages,
): void {
  const { liveThreads } = get();
  const live = liveThreads[threadId];
  if (!live) return;
  set({ liveThreads: { ...liveThreads, [threadId]: updater(live) } } as any);
}

// ── Debounced "refresh all projects" for unknown threads ─────────
// When a WS event arrives for a thread not in any loaded project, we need to
// refresh projects so it appears. But doing this on every event causes an
// O(projects) API storm. Debounce to at most once per 2 seconds.
let _refreshAllTimer: ReturnType<typeof setTimeout> | null = null;
const _pendingRefreshPids = new Set<string>();

function scheduleProjectRefresh(get: Get, specificPid?: string): void {
  if (specificPid) {
    _pendingRefreshPids.add(specificPid);
  }
  if (_refreshAllTimer) return; // already scheduled
  _refreshAllTimer = setTimeout(() => {
    _refreshAllTimer = null;
    const { threadsByProject, loadThreadsForProject } = get();
    if (_pendingRefreshPids.size > 0) {
      for (const pid of _pendingRefreshPids) {
        loadThreadsForProject(pid);
      }
    } else {
      // No specific project — refresh all loaded projects
      for (const pid of Object.keys(threadsByProject)) {
        loadThreadsForProject(pid);
      }
    }
    _pendingRefreshPids.clear();
  }, 2000);
}

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

  updateLiveThread(get, set, threadId, (live) => ({ ...live, initInfo: data }));
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
        // Merge sidebar snippet update into same set() for existing message updates
        const earlyUpdate: Partial<ThreadState> = {
          activeThread: { ...activeThread, messages: updated },
        };
        if (data.role === 'assistant' && data.content) {
          const pid = getProjectIdForThread(threadId);
          if (pid) {
            const { threadsByProject } = get();
            const threads = threadsByProject[pid];
            if (threads) {
              const tidx = threads.findIndex((t) => t.id === threadId);
              if (tidx >= 0) {
                const copy = [...threads];
                copy[tidx] = { ...copy[tidx], lastAssistantMessage: data.content.slice(0, 120) };
                earlyUpdate.threadsByProject = { ...threadsByProject, [pid]: copy };
              }
            }
          }
        }
        set(earlyUpdate as any);
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

    // Build the state update — combine activeThread + sidebar snippet
    // into a single set() call to avoid double store updates per message.
    const stateUpdate: Partial<ThreadState> = {
      activeThread: {
        ...activeThread,
        lastUserMessage,
        messages: [...activeThread.messages, ...extraMessages, newMsg],
      },
    };

    // Update sidebar snippet for assistant messages (merged into same set())
    if (data.role === 'assistant' && data.content) {
      const pid = getProjectIdForThread(threadId);
      if (pid) {
        const { threadsByProject } = get();
        const threads = threadsByProject[pid];
        if (threads) {
          const idx = threads.findIndex((t) => t.id === threadId);
          if (idx >= 0) {
            const updated = [...threads];
            updated[idx] = { ...updated[idx], lastAssistantMessage: data.content.slice(0, 120) };
            stateUpdate.threadsByProject = { ...threadsByProject, [pid]: updated };
          }
        }
      }
    }

    set(stateUpdate as any);
  } else if (selectedThreadId === threadId) {
    bufferWSEvent(threadId, 'message', data);
  }

  // Update live thread for live-column real-time streaming
  updateLiveThread(get, set, threadId, (live) => {
    const messageId = data.messageId;
    if (messageId) {
      const idx = live.messages.findIndex((m) => m.id === messageId);
      if (idx >= 0) {
        const updated = [...live.messages];
        updated[idx] = {
          ...updated[idx],
          content: data.content,
          ...(data.author ? { author: data.author } : {}),
        };
        return { ...live, messages: updated };
      }
    }
    const newMsg = {
      id: messageId || crypto.randomUUID(),
      threadId,
      role: data.role as MessageRole,
      content: data.content,
      timestamp: new Date().toISOString(),
      ...(data.author ? { author: data.author } : {}),
    };
    return {
      ...live,
      messages: [...live.messages, newMsg],
      ...(data.role === 'user' ? { lastUserMessage: newMsg } : {}),
    };
  });

  // Drop the cached snapshot so the next selectThread() refetches. Must run
  // even when the thread is currently active — otherwise switching away and
  // back resolves from the pre-event cache and the new message is invisible
  // until a hard refresh.
  invalidateThreadData(threadId);

  // Update sidebar snippet for assistant messages on non-active threads
  if (activeThread?.id !== threadId && data.role === 'assistant' && data.content) {
    const pid = getProjectIdForThread(threadId);
    if (pid) {
      const { threadsByProject } = get();
      const threads = threadsByProject[pid];
      if (threads) {
        const idx = threads.findIndex((t) => t.id === threadId);
        if (idx >= 0) {
          const updated = [...threads];
          updated[idx] = { ...updated[idx], lastAssistantMessage: data.content.slice(0, 120) };
          set({ threadsByProject: { ...threadsByProject, [pid]: updated } });
        }
      }
    }
  }
}

// ── Tool Call ───────────────────────────────────────────────────

export function handleWSToolCall(
  get: Get,
  set: Set,
  threadId: string,
  data: {
    toolCallId?: string;
    messageId?: string;
    name: string;
    input: unknown;
    author?: string;
    parentToolCallId?: string;
  },
): void {
  const { activeThread, selectedThreadId } = get();

  if (activeThread?.id === threadId) {
    const toolCallId = data.toolCallId || crypto.randomUUID();
    const tcEntry = {
      id: toolCallId,
      messageId: data.messageId || '',
      name: data.name,
      input: JSON.stringify(data.input),
      timestamp: new Date().toISOString(),
      ...(data.author ? { author: data.author } : {}),
      ...(data.parentToolCallId ? { parentToolCallId: data.parentToolCallId } : {}),
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

  // Update live thread for live-column real-time streaming
  updateLiveThread(get, set, threadId, (live) => {
    const tcId = data.toolCallId || crypto.randomUUID();
    const tcEntry = {
      id: tcId,
      messageId: data.messageId || '',
      name: data.name,
      input: JSON.stringify(data.input),
      timestamp: new Date().toISOString(),
      ...(data.author ? { author: data.author } : {}),
      ...(data.parentToolCallId ? { parentToolCallId: data.parentToolCallId } : {}),
    };
    if (live.messages.some((m) => m.toolCalls?.some((tc: any) => tc.id === tcId))) return live;
    if (data.messageId) {
      const msgIdx = live.messages.findIndex((m) => m.id === data.messageId);
      if (msgIdx >= 0) {
        const messages = live.messages.slice();
        const msg = messages[msgIdx];
        messages[msgIdx] = { ...msg, toolCalls: (msg.toolCalls ?? []).concat(tcEntry) };
        return { ...live, messages };
      }
    }
    return {
      ...live,
      messages: live.messages.concat({
        id: data.messageId || crypto.randomUUID(),
        threadId,
        role: 'assistant' as MessageRole,
        content: '',
        timestamp: new Date().toISOString(),
        toolCalls: [tcEntry],
      }),
    };
  });

  // Drop the cached snapshot so the next selectThread() refetches and includes
  // this tool call. Runs unconditionally so the active thread's cache stays in
  // sync with the live activeThread state.
  invalidateThreadData(threadId);
}

// ── Tool Output ─────────────────────────────────────────────────

export function handleWSToolOutput(
  get: Get,
  set: Set,
  threadId: string,
  data: { toolCallId: string; output: string },
): void {
  const { activeThread, selectedThreadId } = get();
  // Cached snapshot would still hold the tool call without its output —
  // invalidate unconditionally so switching away and back doesn't show the
  // stale pre-output state.
  invalidateThreadData(threadId);
  if (activeThread?.id !== threadId) {
    if (selectedThreadId === threadId) bufferWSEvent(threadId, 'tool_output', data);
  } else {
    // Find and update only the specific message containing the tool call.
    for (let i = 0; i < activeThread.messages.length; i++) {
      const msg = activeThread.messages[i];
      if (!msg.toolCalls) continue;
      const tcIdx = msg.toolCalls.findIndex((tc: any) => tc.id === data.toolCallId);
      if (tcIdx < 0) continue;
      const messages = activeThread.messages.slice();
      const updatedTCs = [...msg.toolCalls];
      updatedTCs[tcIdx] = { ...updatedTCs[tcIdx], output: data.output };
      messages[i] = { ...msg, toolCalls: updatedTCs };
      set({ activeThread: { ...activeThread, messages } });
      break;
    }
  }

  // Update live thread
  updateLiveThread(get, set, threadId, (live) => {
    for (let i = 0; i < live.messages.length; i++) {
      const msg = live.messages[i];
      if (!msg.toolCalls) continue;
      const tcIdx = msg.toolCalls.findIndex((tc: any) => tc.id === data.toolCallId);
      if (tcIdx < 0) continue;
      const messages = live.messages.slice();
      const updatedTCs = [...msg.toolCalls];
      updatedTCs[tcIdx] = { ...updatedTCs[tcIdx], output: data.output };
      messages[i] = { ...msg, toolCalls: updatedTCs };
      return { ...live, messages };
    }
    return live;
  });
}

// ── Status ──────────────────────────────────────────────────────

export function handleWSStatus(
  get: Get,
  set: Set,
  threadId: string,
  data: {
    status: string;
    waitingReason?: string;
    permissionRequest?: { toolName: string; toolInput?: string };
    stage?: string;
    permissionMode?: string;
  },
): void {
  const { threadsByProject, activeThread, loadThreadsForProject, selectedThreadId } = get();

  // Buffer status events when thread is selected but not yet fully loaded.
  // Invalidate cache unconditionally so the active thread's snapshot reflects
  // the new status when the user navigates away and returns.
  invalidateThreadData(threadId);
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

  const pid = getProjectIdForThread(threadId);
  if (pid) {
    const threads = threadsByProject[pid];
    if (threads) {
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
      }
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
    const statusChanged = newStatus !== activeThread.status;
    const stageChanged = !!data.stage && data.stage !== activeThread.stage;
    const permModeChanged =
      !!data.permissionMode && data.permissionMode !== activeThread.permissionMode;
    const waitingReasonChanged =
      data.waitingReason !== undefined && data.waitingReason !== activeThread.waitingReason;
    const permReqChanged = !!data.permissionRequest !== !!activeThread.pendingPermission;

    if (
      statusChanged ||
      stageChanged ||
      permModeChanged ||
      waitingReasonChanged ||
      permReqChanged
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

  // Update live thread status
  updateLiveThread(get, set, threadId, (live) => {
    const newStatus = transitionThreadStatus(threadId, machineEvent, live.status, live.cost);
    if (newStatus === 'waiting') {
      return {
        ...live,
        status: newStatus,
        waitingReason: data.waitingReason as any,
        pendingPermission: data.permissionRequest,
        ...(data.stage ? { stage: data.stage as any } : {}),
        ...(data.permissionMode ? { permissionMode: data.permissionMode as any } : {}),
      };
    }
    return {
      ...live,
      status: newStatus,
      waitingReason: undefined,
      pendingPermission: undefined,
      ...(newStatus === 'stopped' || newStatus === 'interrupted' ? { resultInfo: undefined } : {}),
      ...(data.stage ? { stage: data.stage as any } : {}),
      ...(data.permissionMode ? { permissionMode: data.permissionMode as any } : {}),
    };
  });

  if (!foundInSidebar) {
    if (activeThread?.id === threadId) {
      scheduleProjectRefresh(get, activeThread.projectId);
    } else {
      // Thread not found in any loaded project — likely created externally
      // (e.g. Chrome extension ingest). Debounce refresh to avoid API storm.
      scheduleProjectRefresh(get);
    }
  }
}

// ── Result ──────────────────────────────────────────────────────

export function handleWSResult(get: Get, set: Set, threadId: string, data: any): void {
  const { threadsByProject, activeThread, loadThreadsForProject, selectedThreadId } = get();

  // Invalidate the cached snapshot unconditionally so the next selectThread()
  // refetches the final messages/tool calls/resultInfo from the server. This
  // must run even when the result is for the active thread — otherwise the
  // user switches away, comes back, and the data-actor returns the stale
  // pre-completion snapshot, making the thread look as if it never finished.
  invalidateThreadData(threadId);
  // When the result event arrives mid-selection (selectedThreadId match but
  // activeThread not yet hydrated), buffer the event so flushWSBuffer replays
  // it once activeThread is loaded. Sidebar status (threadsByProject) and
  // live-column state are still updated unconditionally below.
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

  const resultPid = getProjectIdForThread(threadId);
  if (resultPid) {
    const threads = threadsByProject[resultPid];
    if (threads) {
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
        updatedProject = { pid: resultPid, threads: copy };
      }
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
      stateUpdate.activeThread = {
        ...activeThread,
        status: resultStatus,
        cost: data.cost ?? activeThread.cost,
        waitingReason: undefined,
        pendingPermission: undefined,
        resultInfo: {
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

  // Update live thread
  updateLiveThread(get, set, threadId, (live) => {
    const newStatus = transitionThreadStatus(
      threadId,
      machineEvent,
      live.status,
      data.cost ?? live.cost,
    );
    const finalStatus = newStatus !== live.status ? newStatus : serverStatus;
    if (finalStatus === 'waiting') {
      return {
        ...live,
        status: finalStatus,
        cost: data.cost ?? live.cost,
        waitingReason: data.waitingReason,
        pendingPermission: data.permissionRequest,
        ...(data.stage ? { stage: data.stage } : {}),
      };
    }
    return {
      ...live,
      status: finalStatus,
      cost: data.cost ?? live.cost,
      waitingReason: undefined,
      pendingPermission: undefined,
      resultInfo: {
        status: finalStatus as 'completed' | 'failed',
        cost: data.cost ?? live.cost,
        duration: data.duration ?? 0,
        error: data.error,
      },
      ...(data.stage ? { stage: data.stage } : {}),
    };
  });

  // If the thread the user is currently viewing just finished, mark it as read
  // so it doesn't show an unread blue dot in the sidebar.
  if (
    activeThread?.id === threadId &&
    (resultStatus === 'completed' ||
      resultStatus === 'failed' ||
      resultStatus === 'stopped' ||
      resultStatus === 'interrupted')
  ) {
    useThreadReadStore.getState().markRead(threadId);
  }

  if (resultStatus === 'waiting') return;

  const projectIdForRefresh =
    activeThread?.id === threadId ? activeThread.projectId : getProjectIdForThread(threadId);

  if (projectIdForRefresh) {
    setTimeout(() => loadThreadsForProject(projectIdForRefresh), 500);
  } else {
    // Thread not found in any loaded project — likely created externally
    // (e.g. Chrome extension ingest). Debounce refresh to avoid API storm.
    scheduleProjectRefresh(get);
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

  // Always persist to the byThread map so the count survives thread switches
  const { queuedCountByThread } = get();
  const updatedMap =
    data.queuedCount > 0
      ? { ...queuedCountByThread, [threadId]: data.queuedCount }
      : (() => {
          const { [threadId]: _, ...rest } = queuedCountByThread;
          return rest;
        })();

  if (activeThread?.id === threadId) {
    wsLog.info('handleWSQueueUpdate: setting queuedCount on activeThread', {
      threadId,
      queuedCount: String(data.queuedCount),
      nextMessage: data.nextMessage?.slice(0, 50) ?? 'none',
      prevQueuedCount: String(activeThread.queuedCount ?? 'undefined'),
    });
    set({
      activeThread: {
        ...activeThread,
        queuedCount: data.queuedCount,
        queuedNextMessage: data.nextMessage,
      },
      queuedCountByThread: updatedMap,
    });
  } else {
    // Even when not the active thread, persist the count for later
    set({ queuedCountByThread: updatedMap });
    wsLog.warn('handleWSQueueUpdate: activeThread mismatch — count persisted to map', {
      threadId,
      activeThreadId: activeThread?.id ?? 'null',
      queuedCount: String(data.queuedCount),
    });
  }

  updateLiveThread(get, set, threadId, (live) => ({
    ...live,
    queuedCount: data.queuedCount,
    queuedNextMessage: data.nextMessage,
  }));
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
  } else {
    set({
      activeThread: {
        ...activeThread,
        compactionEvents: [...(activeThread.compactionEvents ?? []), data],
      },
    });
  }

  updateLiveThread(get, set, threadId, (live) => ({
    ...live,
    compactionEvents: [...(live.compactionEvents ?? []), data],
  }));
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

  // Persist across page reloads — the runtime only keeps usage in memory.
  // context-usage-storage subscribes to this event and writes to localStorage.
  emitContextUsage(threadId, usage);

  // Always persist to the map so it survives thread switches
  const updates: Partial<ThreadState> = {
    contextUsageByThread: { ...contextUsageByThread, [threadId]: usage },
  };

  if (activeThread?.id === threadId) {
    updates.activeThread = { ...activeThread, contextUsage: usage };
  } else if (selectedThreadId === threadId) {
    bufferWSEvent(threadId, 'context_usage', data);
  }

  set(updates as any);

  updateLiveThread(get, set, threadId, (live) => ({ ...live, contextUsage: usage }));
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

  // Show an immediate toast with a user-friendly error
  toast.error(friendlyAgentError(errorMessage), { duration: 8000 });
}

// ── Network-error humanizer ─────────────────────────────────────

/**
 * Network-level error codes/messages that indicate connectivity issues.
 * Maps raw error substrings to i18n keys under `errors.agentNetwork.*`.
 */
const NETWORK_ERROR_PATTERNS: [test: RegExp, i18nKey: string][] = [
  [/EAI_AGAIN/i, 'errors.agentNetwork.dnsFailure'],
  [/ENOTFOUND/i, 'errors.agentNetwork.dnsFailure'],
  [/ENETUNREACH/i, 'errors.agentNetwork.noInternet'],
  [/ECONNREFUSED/i, 'errors.agentNetwork.connectionRefused'],
  [/ECONNRESET/i, 'errors.agentNetwork.connectionReset'],
  [/ETIMEDOUT/i, 'errors.agentNetwork.timeout'],
  [/fetch failed/i, 'errors.agentNetwork.fetchFailed'],
  [/network\s*(error|failure)/i, 'errors.agentNetwork.generic'],
];

function friendlyAgentError(raw: string): string {
  for (const [pattern, key] of NETWORK_ERROR_PATTERNS) {
    if (pattern.test(raw)) {
      return i18n.t(key, {
        defaultValue: 'Connection lost. Please check your internet connection and try again.',
      });
    }
  }
  return raw;
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
