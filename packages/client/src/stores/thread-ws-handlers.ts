/**
 * WebSocket event handlers for thread-store.
 *
 * Each handler patches a single source of truth — `threadDataById` via
 * `mutations.applyThreadDataPatch`. The mutation helper mirrors onto the
 * `activeThread` field iff the patched thread is the currently-selected
 * one, so the right pane stays in sync without a separate write path.
 *
 * Threads visible only in a live column (no `selectedThreadId` match) get
 * the same patch through the same map — no per-surface duplication.
 *
 * If the thread isn't loaded into `threadDataById` yet (rare: WS arrived
 * during a select that hasn't hydrated) the event is buffered and
 * replayed once `selectThread` lands the snapshot.
 */

import type {
  Thread,
  MessageRole,
  ThreadStatus,
  ImageAttachment,
  ThreadStage,
} from '@funny/shared';
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
import * as mutations from './thread-mutations';
import { useThreadReadStore } from './thread-read-store';
import type { ThreadState } from './thread-state';
import {
  bufferWSEvent,
  getNavigate,
  getProjectIdForThread,
  getUrlThreadId,
} from './thread-store-internals';
import type { AgentInitInfo } from './thread-types';

const wsLog = createClientLogger('ws-handlers');

type Get = () => ThreadState;
type Set = (partial: Partial<ThreadState> | ((state: ThreadState) => Partial<ThreadState>)) => void;
const TERMINAL_STATUSES = new Set<ThreadStatus>(['completed', 'failed', 'stopped', 'interrupted']);

function terminalTimestamps(status: ThreadStatus, now = new Date().toISOString()) {
  if (!TERMINAL_STATUSES.has(status)) return {};
  return { completedAt: now, updatedAt: now };
}

function findTailUserMessageWithContent(
  messages: NonNullable<ThreadState['activeThread']>['messages'],
  content: string,
): number {
  const tailIdx = messages.length - 1;
  if (tailIdx < 0) return -1;
  const tail = messages[tailIdx];
  return tail.role === 'user' && tail.content === content ? tailIdx : -1;
}

// ── Sidebar update helper ─────────────────────────────────────
//
// Threads live in a single `threadsById` index; project- vs scratch- buckets
// are just ordered ID arrays around it. So patching a sidebar-visible field
// (status, lastAssistantMessage, cost, stage, etc.) is a one-liner via
// `mutations.patchThread` — regardless of which bucket the thread is in.
//
// This wrapper returns `{ found, patch }` so callers can decide whether to
// fall back to a project refresh for unknown threads. `patch` is `{}` when
// the updater returned the same Thread reference (no React re-render).
function patchSidebarThread(
  get: Get,
  threadId: string,
  updater: (thread: Thread) => Thread,
): { found: boolean; patch: Partial<ThreadState> } {
  const state = get();
  if (!state.threadsById || !state.threadsById[threadId]) {
    return { found: false, patch: {} };
  }
  return { found: true, patch: mutations.patchThread(state, threadId, updater) };
}

/**
 * Convenience wrapper around `patchSidebarThread` for the common case of
 * patching `lastAssistantMessage`. Slices content to 120 chars to match the
 * existing sidebar snippet truncation.
 */
function patchSidebarLastAssistant(
  get: Get,
  threadId: string,
  content: string,
): Partial<ThreadState> {
  const snippet = content.slice(0, 120);
  return patchSidebarThread(get, threadId, (t) => ({ ...t, lastAssistantMessage: snippet })).patch;
}

/** True when the thread payload is loaded in the unified map. */
function isHydrated(state: ThreadState, threadId: string): boolean {
  return !!state.threadDataById[threadId];
}

/**
 * Buffer the event when the thread is being selected but not yet hydrated.
 * Returns true when buffering happened so callers can short-circuit.
 */
function maybeBuffer(state: ThreadState, threadId: string, type: string, data: unknown): boolean {
  if ((getUrlThreadId() ?? state.selectedThreadId) === threadId && !isHydrated(state, threadId)) {
    bufferWSEvent(threadId, type, data);
    return true;
  }
  return false;
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
    const { threadIdsByProject, loadThreadsForProject } = get();
    if (_pendingRefreshPids.size > 0) {
      for (const pid of _pendingRefreshPids) {
        loadThreadsForProject(pid);
      }
    } else {
      // No specific project — refresh all loaded projects
      for (const pid of Object.keys(threadIdsByProject)) {
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
const DEQUEUED_MESSAGE_ID_PREFIX = 'dequeued-';

function isAssistantScaffold(message: { role: string; content: string; toolCalls?: unknown[] }) {
  return message.role === 'assistant' && (!message.content || (message.toolCalls?.length ?? 0) > 0);
}

/**
 * True when the user-message run immediately before `insertionIndex` already
 * contains the buffer entry. This covers both normal appends and the case where
 * a refreshed assistant message already exists after the real dequeued user
 * message.
 */
function userRunBeforeHasMessage(
  messages: Array<{ role: string; content: string }>,
  content: string,
  insertionIndex: number = messages.length,
): boolean {
  for (let i = insertionIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') return false;
    if (m.content === content) return true;
  }
  return false;
}

/**
 * True when the dequeued user card is already represented in the visible turn.
 * Unlike `userRunBeforeHasMessage`, this also tolerates trailing assistant
 * scaffolding (empty assistant rows / tool-call parents). Those rows are often
 * inserted before the queued-message buffer arrives, and render-items may hide
 * the empty assistant row, making a later synthetic append look like two user
 * follow-ups in a row.
 */
function dequeuedUserAlreadyShownInTurn(
  messages: Array<{ role: string; content: string; toolCalls?: unknown[] }>,
  content: string,
  insertionIndex: number = messages.length,
): boolean {
  if (userRunBeforeHasMessage(messages, content, insertionIndex)) return true;

  let beforeAgentScaffold = insertionIndex;
  while (beforeAgentScaffold > 0 && isAssistantScaffold(messages[beforeAgentScaffold - 1])) {
    beforeAgentScaffold -= 1;
  }
  if (beforeAgentScaffold === insertionIndex) return false;
  return userRunBeforeHasMessage(messages, content, beforeAgentScaffold);
}

function trailingAssistantScaffoldStart(
  messages: Array<{ role: string; content: string; toolCalls?: unknown[] }>,
): number {
  let index = messages.length;
  while (index > 0 && isAssistantScaffold(messages[index - 1])) {
    index -= 1;
  }
  return index;
}

function makeDequeuedUserMessage(
  threadId: string,
  dequeuedMsg: DequeuedMessageBuffer,
): {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  images?: ImageAttachment[];
  timestamp: string;
} {
  return {
    id: `${DEQUEUED_MESSAGE_ID_PREFIX}${crypto.randomUUID()}`,
    threadId,
    role: 'user' as MessageRole,
    content: dequeuedMsg.content,
    images: dequeuedMsg.images,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Pull the buffered dequeued user message (if any) for `threadId` and turn it
 * into the synthetic user-card row to splice in BEFORE the agent's first output
 * of the turn. Always clears the buffer when called — even when injection is
 * skipped — so a stale entry can't leak into a later turn.
 *
 * Called from BOTH handleWSMessage (assistant text) and handleWSToolCall;
 * whichever lands first wins. A queued follow-up frequently starts its turn
 * with a tool call rather than assistant text, so gating injection only on
 * assistant messages left the user card invisible for the entire tool phase of
 * the turn — and missing on refresh-less surfaces until the first text landed.
 *
 * Returns [] when nothing is buffered or the user-message run immediately
 * before the insertion point already shows the same content.
 */
function takeDequeuedUserMessages(
  threadId: string,
  messages: Array<{ role: string; content: string }>,
  insertionIndex: number = messages.length,
): Array<{
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  images?: ImageAttachment[];
  timestamp: string;
}> {
  const dequeuedMsg = pendingDequeuedMessages.get(threadId);
  if (!dequeuedMsg) return [];
  pendingDequeuedMessages.delete(threadId);
  if (dequeuedUserAlreadyShownInTurn(messages, dequeuedMsg.content, insertionIndex)) return [];
  return [makeDequeuedUserMessage(threadId, dequeuedMsg)];
}

// ── Init ────────────────────────────────────────────────────────

export function handleWSInit(get: Get, set: Set, threadId: string, data: AgentInitInfo): void {
  set((state) =>
    mutations.applyThreadDataPatch(state, threadId, (t) => ({ ...t, initInfo: data })),
  );
}

// ── Message ─────────────────────────────────────────────────────

export function handleWSMessage(
  get: Get,
  set: Set,
  threadId: string,
  data: { messageId?: string; role: string; content: string; author?: string },
): void {
  const state = get();
  const hydrated = isHydrated(state, threadId);

  wsLog.info('handleWSMessage applying', {
    threadId,
    messageId: data?.messageId ?? '',
    role: data?.role ?? '',
    contentChars: String(data?.content?.length ?? 0),
    selectedMatch: String(state.selectedThreadId === threadId),
    hydrated: String(hydrated),
  });

  // Drop the cached snapshot so the next selectThread() refetches. Must run
  // even for the active thread — otherwise switching away and back resolves
  // from the pre-event cache and the new message is invisible.
  invalidateThreadData(threadId);

  if (!hydrated) {
    if (maybeBuffer(state, threadId, 'message', data)) return;
    // Not hydrated and not selected — still update the sidebar snippet so
    // the row shows the latest assistant message.
    if (data.role === 'assistant' && data.content) {
      const patch = patchSidebarLastAssistant(get, threadId, data.content);
      if (Object.keys(patch).length > 0) set(patch as any);
    }
    return;
  }

  // Apply the message to the loaded payload — works whether the thread is
  // in the right pane, a live column, or both.
  set((s) =>
    mutations.applyThreadDataPatch(s, threadId, (t) => {
      const messageId = data.messageId;

      if (messageId) {
        const existingIdx = t.messages.findIndex((m) => m.id === messageId);
        if (existingIdx >= 0) {
          const updated = [...t.messages];
          const extraMessages =
            data.role === 'assistant'
              ? takeDequeuedUserMessages(threadId, t.messages, existingIdx)
              : [];
          updated[existingIdx] = {
            ...updated[existingIdx],
            content: data.content,
            ...(data.author ? { author: data.author } : {}),
          };
          if (extraMessages.length) updated.splice(existingIdx, 0, ...extraMessages);
          return {
            ...t,
            lastUserMessage: extraMessages.at(-1) ?? t.lastUserMessage,
            messages: updated,
          };
        }
      }

      // If there's a buffered dequeued user message AND the current event is
      // an assistant message, prepend the user message so it appears in the
      // correct position. Skip injection when:
      //   - the incoming message is itself the user message (would double it)
      //   - the payload already shows the same user message immediately before
      //     the insertion point (server-loaded duplicate, e.g. after a thread
      //     refresh; bug 4 — visual duplicate of the dequeued message)
      // Inject the buffered dequeued user card before the agent's first output
      // of the turn. handleWSToolCall does the same — whichever lands first
      // wins (queued turns often start with a tool call, not assistant text).
      const extraMessages =
        data.role === 'assistant' ? takeDequeuedUserMessages(threadId, t.messages) : [];

      const newMsg = {
        id: messageId || crypto.randomUUID(),
        threadId,
        role: data.role as MessageRole,
        content: data.content,
        timestamp: new Date().toISOString(),
        ...(data.author ? { author: data.author } : {}),
      };

      if (data.role === 'user') {
        const optimisticIdx = findTailUserMessageWithContent(t.messages, data.content);
        if (optimisticIdx >= 0) {
          const updated = [...t.messages];
          updated[optimisticIdx] = { ...updated[optimisticIdx], ...newMsg };
          return {
            ...t,
            lastUserMessage: updated[optimisticIdx],
            messages: updated,
          };
        }
      }

      const lastUserMessage =
        extraMessages.length > 0
          ? extraMessages[extraMessages.length - 1]
          : data.role === 'user'
            ? newMsg
            : t.lastUserMessage;

      return {
        ...t,
        lastUserMessage,
        messages: [...t.messages, ...extraMessages, newMsg],
      };
    }),
  );

  // Sidebar snippet for assistant messages (independent of payload patch).
  if (data.role === 'assistant' && data.content) {
    const patch = patchSidebarLastAssistant(get, threadId, data.content);
    if (Object.keys(patch).length > 0) set(patch as any);
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
  const state = get();

  // Drop the cached snapshot so the next selectThread() refetches and includes
  // this tool call. Runs unconditionally so the active thread's cache stays in
  // sync with the live payload.
  invalidateThreadData(threadId);

  if (!isHydrated(state, threadId)) {
    maybeBuffer(state, threadId, 'tool_call', data);
    return;
  }

  set((s) =>
    mutations.applyThreadDataPatch(s, threadId, (t) => {
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

      // De-dup against any existing entry — WS retries can land twice.
      if (t.messages.some((m) => m.toolCalls?.some((tc: any) => tc.id === toolCallId))) {
        return t;
      }

      // A queued follow-up often starts its turn with a tool call. Inject the
      // buffered dequeued user card now — before this tool call's message — so
      // it doesn't stay invisible until the first assistant text lands. Placed
      // after the de-dup guard so a retried tool call can't consume the buffer.
      const extra = takeDequeuedUserMessages(threadId, t.messages);
      const userPatch = extra.length ? { lastUserMessage: extra[extra.length - 1] } : null;

      if (data.messageId) {
        const msgIdx = t.messages.findIndex((m) => m.id === data.messageId);
        if (msgIdx >= 0) {
          const messages = t.messages.slice();
          const msg = messages[msgIdx];
          messages[msgIdx] = {
            ...msg,
            toolCalls: (msg.toolCalls ?? []).concat(tcEntry),
          };
          if (extra.length) messages.splice(msgIdx, 0, ...extra);
          return { ...t, ...userPatch, messages };
        }
      }

      return {
        ...t,
        ...userPatch,
        messages: [
          ...t.messages,
          ...extra,
          {
            id: data.messageId || crypto.randomUUID(),
            threadId,
            role: 'assistant' as MessageRole,
            content: '',
            timestamp: new Date().toISOString(),
            toolCalls: [tcEntry],
          },
        ],
      };
    }),
  );
}

// ── Tool Output ─────────────────────────────────────────────────

export function handleWSToolOutput(
  get: Get,
  set: Set,
  threadId: string,
  data: { toolCallId: string; output: string },
): void {
  // Cached snapshot would still hold the tool call without its output —
  // invalidate unconditionally so switching away and back doesn't show the
  // stale pre-output state.
  invalidateThreadData(threadId);

  const state = get();
  if (!isHydrated(state, threadId)) {
    maybeBuffer(state, threadId, 'tool_output', data);
    return;
  }

  set((s) =>
    mutations.applyThreadDataPatch(s, threadId, (t) => {
      // Find and update only the specific message containing the tool call.
      for (let i = 0; i < t.messages.length; i++) {
        const msg = t.messages[i];
        if (!msg.toolCalls) continue;
        const tcIdx = msg.toolCalls.findIndex((tc: any) => tc.id === data.toolCallId);
        if (tcIdx < 0) continue;
        const messages = t.messages.slice();
        const updatedTCs = [...msg.toolCalls];
        updatedTCs[tcIdx] = { ...updatedTCs[tcIdx], output: data.output };
        messages[i] = { ...msg, toolCalls: updatedTCs };
        return { ...t, messages };
      }
      return t;
    }),
  );
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
  // Buffer status events when thread is selected but not yet fully loaded.
  // Invalidate cache unconditionally so the active thread's snapshot reflects
  // the new status when the user navigates away and returns.
  invalidateThreadData(threadId);

  const state = get();
  if (!isHydrated(state, threadId)) {
    maybeBuffer(state, threadId, 'status', data);
    // Sidebar still gets the status update below.
  }

  const machineEvent = wsEventToMachineEvent('agent:status', data);
  if (!machineEvent) {
    wsLog.warn('Invalid status transition', { threadId, status: data.status });
    return;
  }

  // Apply the status transition to whichever sidebar bucket holds the thread
  // (project or scratch). `patchSidebarThread` walks both and returns a
  // single partial state update for atomic application below.
  const { found: foundInSidebar, patch: sidebarPatch } = patchSidebarThread(get, threadId, (t) => {
    const newStatus = transitionThreadStatus(threadId, machineEvent, t.status, t.cost);
    const statusTimestamps = terminalTimestamps(newStatus);
    wsLog.debug('status transition', {
      threadId,
      from: t.status,
      to: newStatus,
      waitingReason: data.waitingReason ?? '',
    });
    if (
      newStatus === t.status &&
      (!data.stage || data.stage === t.stage) &&
      (!data.permissionMode || data.permissionMode === t.permissionMode)
    ) {
      return t;
    }
    return {
      ...t,
      status: newStatus,
      ...statusTimestamps,
      ...(data.stage ? { stage: data.stage as any } : {}),
      ...(data.permissionMode ? { permissionMode: data.permissionMode as any } : {}),
    };
  });

  // Apply the same transition to the loaded payload (right pane / live column).
  const payloadPatch = mutations.applyThreadDataPatch(state, threadId, (t) => {
    const newStatus = transitionThreadStatus(threadId, machineEvent, t.status, t.cost);
    const statusChanged = newStatus !== t.status;
    const stageChanged = !!data.stage && data.stage !== t.stage;
    const permModeChanged = !!data.permissionMode && data.permissionMode !== t.permissionMode;
    const waitingReasonChanged =
      data.waitingReason !== undefined && data.waitingReason !== t.waitingReason;
    const permReqChanged = !!data.permissionRequest !== !!t.pendingPermission;
    if (
      !(statusChanged || stageChanged || permModeChanged || waitingReasonChanged || permReqChanged)
    ) {
      return t;
    }
    if (newStatus === 'waiting' && !data.waitingReason) {
      wsLog.warn('BUG-HUNT: agent:status waiting but NO waitingReason', {
        threadId,
        dataStatus: data.status,
      });
    }
    if (newStatus === 'waiting') {
      return {
        ...t,
        status: newStatus,
        waitingReason: data.waitingReason as any,
        pendingPermission: data.permissionRequest,
        ...(data.stage ? { stage: data.stage as any } : {}),
        ...(data.permissionMode ? { permissionMode: data.permissionMode as any } : {}),
      };
    }
    return {
      ...t,
      status: newStatus,
      ...terminalTimestamps(newStatus),
      waitingReason: undefined,
      pendingPermission: undefined,
      ...(newStatus === 'stopped' || newStatus === 'interrupted' ? { resultInfo: undefined } : {}),
      ...(data.stage ? { stage: data.stage as any } : {}),
      ...(data.permissionMode ? { permissionMode: data.permissionMode as any } : {}),
    };
  });

  const combined = { ...sidebarPatch, ...payloadPatch };
  if (Object.keys(combined).length > 0) {
    set(combined as any);
  }

  if (!foundInSidebar) {
    const pid = state.threadDataById[threadId]?.projectId;
    if (pid) {
      scheduleProjectRefresh(get, pid);
    } else {
      // Thread not found in any loaded project — likely created externally
      // (e.g. Chrome extension ingest). Debounce refresh to avoid API storm.
      scheduleProjectRefresh(get);
    }
  }
}

// ── Stage changed ───────────────────────────────────────────────
//
// The server emits `thread:stage-changed` for EVERY stage transition —
// both user-driven (a Kanban drag, echoed back to all of the user's
// tabs) and server-driven (e.g. an agent finishing auto-transitions the
// thread from `in_progress` to `review`). Without a client handler the
// board only reflected the optimistic local drag and silently dropped
// every server-driven move, so a completed card stayed stranded in the
// "In Progress" column until a manual reload. This patches the same
// single source of truth as the other handlers so the board (and the
// right pane) stay live.
export function handleWSStageChanged(
  get: Get,
  set: Set,
  threadId: string,
  data: { fromStage: ThreadStage | null; toStage: ThreadStage; projectId: string },
): void {
  const toStage = data.toStage;
  // The Kanban derives a card's column from `archived ? 'archived' : stage`.
  // Keep both fields consistent: archiving flips the flag; any other target
  // both clears `archived` (un-archive) and sets the new stage.
  const apply = <T extends Thread>(t: T): T => {
    if (toStage === 'archived') {
      return t.archived ? t : { ...t, archived: true };
    }
    if (t.archived || t.stage !== toStage) {
      return { ...t, archived: false, stage: toStage };
    }
    return t;
  };

  const { found, patch: sidebarPatch } = patchSidebarThread(get, threadId, apply);
  const payloadPatch = mutations.applyThreadDataPatch(get(), threadId, apply);
  const combined = { ...sidebarPatch, ...payloadPatch };
  if (Object.keys(combined).length > 0) set(combined as any);

  if (!found) {
    scheduleProjectRefresh(get, data.projectId || undefined);
  }
}

// ── Result ──────────────────────────────────────────────────────

export function handleWSResult(get: Get, set: Set, threadId: string, data: any): void {
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
    hydrated: String(isHydrated(state, threadId)),
  });

  // Apply the result transition to whichever sidebar bucket holds the thread.
  // The updater closes over `resultStatus` to also expose the resolved status
  // back to the caller for the toast/notification + payload paths.
  const { patch: sidebarPatch, found: foundInSidebar } = patchSidebarThread(get, threadId, (t) => {
    const newStatus = transitionThreadStatus(threadId, machineEvent, t.status, data.cost ?? t.cost);
    // Use server status as authoritative if xstate transition didn't change state
    // (e.g., actor was in stale state that didn't accept the event)
    const nextStatus = newStatus !== t.status ? newStatus : serverStatus;
    const statusTimestamps = terminalTimestamps(nextStatus);
    resultStatus = nextStatus;
    if (
      nextStatus === t.status &&
      (data.cost === undefined || data.cost === t.cost) &&
      (!data.stage || data.stage === t.stage) &&
      Object.keys(statusTimestamps).length === 0
    ) {
      return t;
    }
    return {
      ...t,
      status: nextStatus,
      cost: data.cost ?? t.cost,
      ...statusTimestamps,
      ...(data.stage ? { stage: data.stage } : {}),
    };
  });
  // Scratch threads sit outside any project, so the post-result fallback
  // (`loadThreadsForProject` / `scheduleProjectRefresh`) should be skipped.
  const sidebarHitScratch = state.scratchThreadIds.includes(threadId);

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
        ...(data.stage ? { stage: data.stage } : {}),
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
      ...(data.stage ? { stage: data.stage } : {}),
    };
  });

  set({ ...sidebarPatch, ...payloadPatch } as any);

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
          messages.splice(insertionIndex, 0, makeDequeuedUserMessage(threadId, orphaned));
          return {
            ...t,
            messages,
          };
        }),
      );
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
    payloadEntry && !payloadEntry.isScratch
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
  // Buffer dequeued message — will be injected on next agent:message to ensure
  // it appears after the previous agent's response (correct visual ordering).
  // Works for any thread, regardless of which surface holds it.
  const dequeuedMsg = data.dequeuedMessage
    ? {
        content: data.dequeuedMessage,
        images: data.dequeuedImages,
      }
    : null;
  if (dequeuedMsg) {
    pendingDequeuedMessages.set(threadId, dequeuedMsg);
  }

  set((state) => {
    const updatedMap =
      data.queuedCount > 0
        ? { ...state.queuedCountByThread, [threadId]: data.queuedCount }
        : (() => {
            const { [threadId]: _, ...rest } = state.queuedCountByThread;
            return rest;
          })();
    const updatedMessageMap =
      data.queuedCount > 0 && data.nextMessage
        ? { ...state.queuedNextMessageByThread, [threadId]: data.nextMessage }
        : (() => {
            const { [threadId]: _, ...rest } = state.queuedNextMessageByThread;
            return rest;
          })();
    const cachedQueue = state.queuedMessagesByThread[threadId];
    const shouldKeepCachedQueue =
      data.queuedCount > 0 && (!data.nextMessage || cachedQueue?.[0]?.content === data.nextMessage);
    const updatedQueueMap = shouldKeepCachedQueue
      ? state.queuedMessagesByThread
      : (() => {
          const { [threadId]: _, ...rest } = state.queuedMessagesByThread;
          return rest;
        })();
    return {
      queuedCountByThread: updatedMap,
      queuedMessagesByThread: updatedQueueMap,
      queuedNextMessageByThread: updatedMessageMap,
      ...mutations.applyThreadDataPatch(state, threadId, (t) => {
        const nextThread = {
          ...t,
          queuedCount: data.queuedCount,
          queuedNextMessage: data.nextMessage,
        };
        if (!dequeuedMsg) return nextThread;
        if (dequeuedUserAlreadyShownInTurn(t.messages, dequeuedMsg.content)) {
          pendingDequeuedMessages.delete(threadId);
          return nextThread;
        }
        const insertionIndex = trailingAssistantScaffoldStart(t.messages);
        if (insertionIndex < t.messages.length) {
          pendingDequeuedMessages.delete(threadId);
          const messages = t.messages.slice();
          messages.splice(insertionIndex, 0, makeDequeuedUserMessage(threadId, dequeuedMsg));
          return { ...nextThread, messages };
        }
        return nextThread;
      }),
    };
  });
}

// ── Compact boundary ────────────────────────────────────────────

export function handleWSCompactBoundary(
  get: Get,
  set: Set,
  threadId: string,
  data: { trigger: 'manual' | 'auto'; preTokens: number; postTokens?: number; timestamp: string },
): void {
  const state = get();
  if (!isHydrated(state, threadId)) {
    maybeBuffer(state, threadId, 'compact_boundary', data);
    return;
  }
  // Mirror the server-side reset of cumulativeInputTokens (agent-message-handler.ts).
  // Without this the context-usage ring stays frozen at the pre-compaction value
  // until the next agent turn emits a fresh context_usage event. Use the
  // SDK-reported post-compaction size when available so the ring reflects the
  // real reduced context instead of dropping to 0 (which hides the ring).
  const post = data.postTokens ?? 0;
  const resetUsage = {
    cumulativeInputTokens: post,
    lastInputTokens: post,
    lastOutputTokens: 0,
  };
  emitContextUsage(threadId, resetUsage);
  set((s) => ({
    contextUsageByThread: { ...s.contextUsageByThread, [threadId]: resetUsage },
    ...mutations.applyThreadDataPatch(s, threadId, (t) => ({
      ...t,
      contextUsage: resetUsage,
      compactionEvents: [...(t.compactionEvents ?? []), data],
    })),
  }));
}

// ── Context usage ───────────────────────────────────────────────

export function handleWSContextUsage(
  get: Get,
  set: Set,
  threadId: string,
  data: { inputTokens: number; outputTokens: number; cumulativeInputTokens: number },
): void {
  const usage = {
    cumulativeInputTokens: data.cumulativeInputTokens,
    lastInputTokens: data.inputTokens,
    lastOutputTokens: data.outputTokens,
  };

  // Persist across page reloads — the runtime only keeps usage in memory.
  // context-usage-storage subscribes to this event and writes to localStorage.
  emitContextUsage(threadId, usage);

  set((state) => {
    const updates: Partial<ThreadState> = {
      contextUsageByThread: { ...state.contextUsageByThread, [threadId]: usage },
    };
    if (!isHydrated(state, threadId)) {
      if ((getUrlThreadId() ?? state.selectedThreadId) === threadId)
        bufferWSEvent(threadId, 'context_usage', data);
      return updates;
    }
    return {
      ...updates,
      ...mutations.applyThreadDataPatch(state, threadId, (t) => ({ ...t, contextUsage: usage })),
    };
  });
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

  // Delegate status transition to the existing handler (updates sidebar + payload)
  handleWSStatus(get, set, threadId, { status: 'failed' });

  // Now enrich the payload with resultInfo so AgentResultCard renders the error.
  // Works for any hydrated thread (right pane or live column).
  set((state) =>
    mutations.applyThreadDataPatch(state, threadId, (t) =>
      t.resultInfo
        ? t
        : {
            ...t,
            resultInfo: {
              status: 'failed' as const,
              cost: t.cost ?? 0,
              duration: 0,
              error: errorMessage,
            },
          },
    ),
  );

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
  get: Get,
  errorReason?: string,
): void {
  let threadTitle = 'Thread';
  let projectId: string | null = null;

  // Look up the thread from the unified index. Project / scratch / unknown
  // all resolve uniformly. Falls back to the loaded payload below for cases
  // where the thread was never loaded into the sidebar.
  const state = get();
  const t = state.threadsById[threadId];
  if (t) {
    threadTitle = t.title ?? threadTitle;
    // Scratch threads keep projectId = null, so downstream notification
    // routing falls through to a no-op rather than guessing.
    if (!t.isScratch) projectId = t.projectId;
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
    toast.error(`"${truncated}" failed: ${reason}`, { ...toastOpts, duration: 8000 });
  }
}
