import {
  createRealtimeDispatcher,
  type RealtimeActionPorts,
  type RealtimeEffect,
  type RealtimeEvent,
} from '@funny/client-core';
import { isTerminalSessionUnavailable } from '@funny/shared/socket-events';
import { startTransition } from 'react';
import type { Socket } from 'socket.io-client';

import {
  applyActivitiesRemoved,
  applyActivityProgress,
  applyActivityUpdated,
} from '@/data/activities/apply-event';
import { applyApprovalRequested, applyApprovalResolved } from '@/data/approvals/store';
import { handleRunCompleted, handleRunStarted, handleRunUpdated } from '@/data/automations/events';
import { applyFactorySetupUpdated } from '@/data/factory/queries';
import { getThreadsData } from '@/data/threads/store';
import { closePreviewForCommand } from '@/hooks/use-preview-window';
import { validateContainerUrl } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import type { BrowserSessionRealtimeEvent } from '@/lib/realtime/browser-session-v1-events';
import { metric, startSpan } from '@/lib/telemetry';
import { clientComposition } from '@/platform/client-composition';
import { notifyActivityFailed } from '@/stores/activity-notifications';
import { useCheckRunsStore } from '@/stores/check-runs-store';
import { useProjectStore } from '@/stores/project-store';
import { notifyPtySessionLost, useTerminalStore } from '@/stores/terminal-store';
import { useThreadStore } from '@/stores/thread-store';
import { handleWSAgentAccount } from '@/stores/thread-ws-handlers';

import { dispatchBrowserSessionEvent } from './dispatch-browser-session-events';
import { dispatchTestEvent } from './dispatch-test-events';
import {
  handleGitRefsUpdated,
  handleGitStatus,
  handleGitWorkflowProgress,
} from './ws-event-dispatch-git-events';
import { maybeNotifyAgentResult } from './ws-event-dispatch-notifications';
import { notifyReviewDirty, type ThreadStoreState } from './ws-event-dispatch-shared';
import {
  handlePresenceJoin,
  handleRunnerStatus,
  handleShareRevoked,
  handleThreadComment,
  handleThreadCommentDeleted,
  handleThreadCreated,
  handleThreadDeleted,
  handleThreadEvent,
  handleThreadStageChanged,
  handleThreadUpdated,
  upsertJob,
  upsertWatcher,
  withPipelineStore,
  withPresenceStore,
} from './ws-event-dispatch-thread-events';

const wsLog = createClientLogger('ws');

// ── Remote container WS connections ─────────────────────────────
const remoteConnections = new Map<string, WebSocket>();
const remoteReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
let stopped = false;

// ── WS message batching ─────────────────────────────────────────
interface BufferedMessage {
  threadId: string;
  data: any;
}

// Keyed by `${threadId}:${messageId}` so streaming chunks of the SAME message
// collapse (server emits each chunk with cumulative content + same messageId)
// but DIFFERENT messages for the same thread are preserved. Previously this
// was keyed by threadId alone, which dropped earlier messages when multiple
// arrived between flushes — e.g. while the tab was hidden and RAF was paused.
let pendingMessages = new Map<string, BufferedMessage>();
let pendingToolOutputs: Array<{ threadId: string; data: any }> = [];
// Tool calls, with the messages that arrived before each one, in arrival
// order. A tool call must apply after the messages queued ahead of it (its
// parent may only exist as one of them), so they are moved here together and
// applied first in the next flush — the order an immediate apply used to give,
// but in the frame's single commit instead of one commit per tool call.
interface OrderedOp {
  kind: 'message' | 'toolCall';
  threadId: string;
  data: any;
}
let pendingOrdered: OrderedOp[] = [];
let pendingStatuses = new Map<string, BufferedMessage>();
let rafId: number | null = null;
let fallbackFlushTimer: ReturnType<typeof setTimeout> | null = null;
const FALLBACK_FLUSH_MS = 250;

function pendingMessageKey(threadId: string, data: any): string {
  // Fall back to threadId when messageId is missing (defensive — server should
  // always include it). Without messageId we can't dedupe across chunks anyway.
  return `${threadId}:${data?.messageId ?? ''}`;
}

// Server sometimes emits identical agent:status events back-to-back. Dedup
// per-thread so Zustand doesn't fire duplicate updates.
const lastStatusByThread = new Map<string, string>();

const FILE_MODIFYING_TOOLS = new Set(['Write', 'Edit', 'Bash']);

function cancelScheduledFlush(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (fallbackFlushTimer) {
    clearTimeout(fallbackFlushTimer);
    fallbackFlushTimer = null;
  }
}

function flushBatch() {
  rafId = null;
  if (fallbackFlushTimer) {
    clearTimeout(fallbackFlushTimer);
    fallbackFlushTimer = null;
  }

  const batch = drainPendingBatch();
  const { msgs, toolOutputs, statuses, ordered } = batch;

  const total = msgs.length + toolOutputs.length + statuses.length + ordered.length;
  if (total === 0) return;

  const span = startSpan('ws.flushBatch', {
    attributes: {
      'batch.messages': msgs.length,
      'batch.tool_outputs': toolOutputs.length,
      'batch.statuses': statuses.length,
      'batch.ordered': ordered.length,
    },
  });
  const t0 = performance.now();

  startTransition(() => {
    // One synced commit for every thread-row change in this frame, so the
    // sidebar projection and live queries (Kanban, lists) recompute once.
    getThreadsData().batchWrites(() => applyBatch(useThreadStore.getState(), batch));
  });

  const elapsed = performance.now() - t0;
  span.end();
  metric('ws.flushBatch.size', total, { type: 'gauge' });
  if (elapsed > 16) {
    metric('ws.flushBatch.slow', 1, { type: 'sum', attributes: { reason: 'over-1-frame' } });
  }
}

function scheduleFlush() {
  if (rafId === null) {
    rafId = requestAnimationFrame(flushBatch);
  }
  if (fallbackFlushTimer === null) {
    fallbackFlushTimer = setTimeout(() => {
      fallbackFlushTimer = null;
      cancelScheduledFlush();
      flushBatch();
    }, FALLBACK_FLUSH_MS);
  }
}

/** Every realtime event carries its fields as an object; the dispatcher only types it `unknown`. */
function hasEventFields(data: unknown): data is BrowserSessionRealtimeEvent['data'] {
  return typeof data === 'object' && data !== null;
}

/**
 * Dispatch a received event (from Socket.IO or raw WS) to the appropriate
 * store. The event object has { type, threadId, data } shape.
 */
const applyThroughWebStore = (event: RealtimeEvent): void => {
  applyWebEvent(event.type, event.threadId, event.data);
};

const actionPorts: RealtimeActionPorts = {
  agent: applyThroughWebStore,
  terminal: applyThroughWebStore,
  thread: applyThroughWebStore,
  git: applyThroughWebStore,
  automation: applyThroughWebStore,
  pipeline: applyThroughWebStore,
  workflow: applyThroughWebStore,
  presence: applyThroughWebStore,
  testing: applyThroughWebStore,
  // Browser sessions arrive only as browser.v1 (decoded in use-ws.ts), never
  // as Socket.IO events, so they skip the web event table.
  browserSession: (event) => {
    if (hasEventFields(event.data)) dispatchBrowserSessionEvent(event.type, event.data);
  },
  infrastructure: applyThroughWebStore,
};

function applyRealtimeEffect(effect: RealtimeEffect): void {
  switch (effect.type) {
    case 'agent-result':
      maybeNotifyAgentResult(effect.threadId, effect);
      break;
    case 'terminal-error':
      clientComposition.platform.effects.emit({
        type: 'toast',
        level: 'error',
        message: effect.message,
      });
      break;
    case 'environment-activated':
      clientComposition.platform.effects.emit({
        type: 'toast',
        level: 'success',
        message: 'Activated environment',
        description: effect.activations
          .map((activation) => `${activation.kind}: ${activation.detail}`)
          .join('\n'),
      });
      break;
    case 'application-event':
      clientComposition.platform.effects.emit({
        type: 'application-event',
        name: effect.name,
        detail: effect.detail,
      });
      break;
    case 'hook-failed':
      clientComposition.platform.effects.emit({
        type: 'toast',
        level: 'error',
        message: 'Pre-commit hook failed',
        description: effect.message,
      });
      break;
    case 'push-completed':
      clientComposition.platform.effects.emit({
        type: 'toast',
        level: 'success',
        message: 'Pushed successfully',
      });
      break;
  }
}

const realtimeDispatcher = createRealtimeDispatcher({
  actions: actionPorts,
  effects: { emit: applyRealtimeEffect },
});

function dispatchEvent(type: string, threadId: string, data: any): void {
  realtimeDispatcher.dispatch({ type, threadId, data });
}

/** Feed a transport-neutral event through the same state pipeline as legacy Socket.IO events. */
export function dispatchRealtimeEvent<EventData>(
  type: string,
  threadId: string,
  data: EventData,
): void {
  dispatchEvent(type, threadId, data);
}

// ── Web event handlers (table-driven dispatch) ──────────────────

type WebEventType = (typeof ALL_EVENT_TYPES)[number];
type WebEventHandler = (threadId: string, data: any, type: string) => void;

function noop(): void {}

/** Run a thread-store action inside a React transition (store read lazily). */
function inTransition(
  apply: (store: ThreadStoreState, threadId: string, data: any) => void,
): WebEventHandler {
  return (threadId, data) => {
    startTransition(() => {
      apply(useThreadStore.getState(), threadId, data);
    });
  };
}

interface PendingBatch {
  msgs: BufferedMessage[];
  toolOutputs: Array<{ threadId: string; data: any }>;
  statuses: BufferedMessage[];
  ordered: OrderedOp[];
}

function drainPendingBatch(): PendingBatch {
  const msgs = Array.from(pendingMessages.values());
  const toolOutputs = pendingToolOutputs.slice();
  const statuses = Array.from(pendingStatuses.values());
  const ordered = pendingOrdered;
  pendingMessages.clear();
  pendingToolOutputs = [];
  pendingStatuses.clear();
  pendingOrdered = [];
  return { msgs, toolOutputs, statuses, ordered };
}

/**
 * Apply a drained batch. Ordered ops (tool calls and the messages queued
 * before them) go first: they arrived before everything still pending.
 */
function applyBatch(store: ThreadStoreState, batch: PendingBatch): void {
  for (const op of batch.ordered) {
    if (op.kind === 'message') store.handleWSMessage(op.threadId, op.data);
    else store.handleWSToolCall(op.threadId, op.data);
  }
  for (const entry of batch.statuses) store.handleWSStatus(entry.threadId, entry.data);
  for (const entry of batch.msgs) store.handleWSMessage(entry.threadId, entry.data);
  for (const entry of batch.toolOutputs) store.handleWSToolOutput(entry.threadId, entry.data);
}

/** Move the messages queued so far into the ordered queue, ahead of a tool call. */
function takePendingMessagesInOrder(): void {
  for (const entry of pendingMessages.values()) {
    pendingOrdered.push({ kind: 'message', threadId: entry.threadId, data: entry.data });
  }
  pendingMessages.clear();
}

function handleAgentMessage(threadId: string, data: any): void {
  const key = pendingMessageKey(threadId, data);
  const collapsed = pendingMessages.has(key);
  wsLog.debug('agent:message received', {
    threadId,
    messageId: data?.messageId ?? '',
    role: data?.role ?? '',
    contentChars: String(data?.content?.length ?? 0),
    collapsedPrevious: String(collapsed),
  });
  pendingMessages.set(key, { threadId, data });
  scheduleFlush();
}

function handleAgentToolOutput(threadId: string, data: any): void {
  pendingToolOutputs.push({ threadId, data });
  scheduleFlush();
}

function permissionCapabilityKey(data: any): string {
  const capability = data.permissionApprovalCapability;
  return `${capability?.kind ?? ''}|${capability?.transport ?? capability?.reason ?? ''}`;
}

function agentStatusKey(data: any): string {
  return `${data.status}|${data.waitingReason ?? ''}|${data.permissionRequest?.toolName ?? ''}|${data.pendingPermissionRequest?.requestId ?? ''}|${permissionCapabilityKey(data)}|${data.stage ?? ''}|${data.permissionMode ?? ''}`;
}

function handleAgentStatus(threadId: string, data: any): void {
  const statusKey = agentStatusKey(data);
  const prev = lastStatusByThread.get(threadId);
  if (prev === statusKey) return;
  lastStatusByThread.set(threadId, statusKey);

  wsLog.debug('agent:status', {
    threadId,
    status: data.status,
    waitingReason: data.waitingReason ?? '',
    permissionRequest: data.permissionRequest?.toolName ?? '',
  });

  if (data.status === 'waiting' || data.permissionRequest || data.pendingPermissionRequest) {
    // Apply what is still queued first, in order: applied afterwards, a queued
    // `running` would put the thread back to running and clear the waiting
    // card, and dropping it would lose the stage or mode it carried.
    flushPendingBatchNow();
    startTransition(() => {
      useThreadStore.getState().handleWSStatus(threadId, data);
    });
  } else {
    pendingStatuses.set(threadId, { threadId, data });
    scheduleFlush();
  }
}

function logAgentResult(threadId: string, data: any, resultStatus: string): void {
  wsLog.info('agent:result', {
    threadId,
    status: resultStatus,
    cost: String(data.cost ?? ''),
    errorReason: data.errorReason ?? '',
    isWaiting: String(data.status === 'waiting'),
  });
}

/** Cancel the scheduled flush and apply everything pending synchronously. */
function flushPendingBatchNow(): void {
  cancelScheduledFlush();
  const batch = drainPendingBatch();
  const { statuses, msgs, toolOutputs, ordered } = batch;
  if (statuses.length + msgs.length + toolOutputs.length + ordered.length === 0) return;
  applyBatch(useThreadStore.getState(), batch);
}

function handleAgentResult(threadId: string, data: any): void {
  lastStatusByThread.delete(threadId);

  const resultStatus = String(data.status ?? '');
  logAgentResult(threadId, data, resultStatus);
  // Permanent counter: lets us see in Abbacchio whether the result event
  // even reached the client. A stuck "loading" thread with no `ws.result`
  // sample means the event was dropped at the transport layer.
  metric('ws.result_received', 1, { attributes: { status: resultStatus } });
  // Permanent span: covers the gap between "event arrived" and "store
  // applied final state" — surfaces React 19 transition lag under load.
  const dispatchSpan = startSpan('ws.dispatch_result', {
    attributes: { status: resultStatus },
  });

  flushPendingBatchNow();

  startTransition(() => {
    useThreadStore.getState().handleWSResult(threadId, data);
    dispatchSpan.end('OK');
  });

  notifyReviewDirty(threadId);
}

function handleAgentToolCall(threadId: string, data: any): void {
  if (data.name === 'AskUserQuestion' || data.name === 'ExitPlanMode') {
    wsLog.info('interactive tool_call received', {
      threadId,
      toolName: data.name,
      toolCallId: data.toolCallId ?? '',
    });
  }
  takePendingMessagesInOrder();
  pendingOrdered.push({ kind: 'toolCall', threadId, data });
  if (data.name === 'AskUserQuestion' || data.name === 'ExitPlanMode') {
    // Interactive tools apply at once, as before: a `waiting` status is not
    // batched, so deferring the question card would show the thread waiting
    // without it for a frame.
    const ordered = pendingOrdered;
    pendingOrdered = [];
    startTransition(() => {
      applyBatch(useThreadStore.getState(), { ordered, msgs: [], statuses: [], toolOutputs: [] });
    });
  } else {
    scheduleFlush();
  }
  if (FILE_MODIFYING_TOOLS.has(data.name)) {
    notifyReviewDirty(threadId);
  }
}

function handleAgentError(threadId: string, data: any): void {
  wsLog.error('agent:error', { threadId, error: data.error ?? 'unknown' });
  // The error ends the run: what is still queued is older, so it applies first,
  // and the next run's first status must not be dropped as a duplicate of this
  // run's.
  flushPendingBatchNow();
  lastStatusByThread.delete(threadId);
  startTransition(() => {
    useThreadStore.getState().handleWSError(threadId, data);
  });
}

function handleCommandStatus(_threadId: string, data: any): void {
  if (data.status === 'exited' || data.status === 'stopped') {
    useTerminalStore.getState().markCommandExited(data.commandId);
    closePreviewForCommand(data.commandId);
  }
}

function handleNativeGitBuild(_threadId: string, data: any, type: string): void {
  import('@/stores/native-git-store').then(({ useNativeGitStore }) => {
    const store = useNativeGitStore.getState();
    if (type === 'native-git:build_output') {
      store.appendBuildOutput(data.text);
    } else {
      store.setBuildStatus(data.status, data.exitCode);
    }
  });
}

const testEventHandler: WebEventHandler = (_threadId, data, type) => {
  dispatchTestEvent(type, data);
};

/**
 * One handler per event type. Typed as a full `Record` over `ALL_EVENT_TYPES`
 * so registering a new Socket.IO event without a handler is a compile error.
 */
const WEB_EVENT_HANDLERS: Record<WebEventType, WebEventHandler> = {
  'agent:message': handleAgentMessage,
  'agent:tool_output': handleAgentToolOutput,
  'agent:check_run': (threadId, data) => {
    useCheckRunsStore.getState().record(threadId, data);
  },
  'agent:init': inTransition((store, threadId, data) => store.handleWSInit(threadId, data)),
  'agent:status': handleAgentStatus,
  'agent:result': handleAgentResult,
  'agent:tool_call': handleAgentToolCall,
  'agent:error': handleAgentError,
  'agent:compact_boundary': inTransition((store, threadId, data) =>
    store.handleWSCompactBoundary(threadId, data),
  ),
  'agent:context_usage': inTransition((store, threadId, data) =>
    store.handleWSContextUsage(threadId, data),
  ),
  'agent:account': (threadId, data) => handleWSAgentAccount(threadId, data),
  'command:output': (_threadId, data) => {
    useTerminalStore.getState().appendCommandOutput(data.commandId, data.data);
  },
  'command:status': handleCommandStatus,
  'command:metrics': (_threadId, data) => {
    useTerminalStore.getState().updateCommandMetrics(data);
  },
  'native-git:build_output': handleNativeGitBuild,
  'native-git:build_status': handleNativeGitBuild,
  'automation:run_started': (threadId, data) => {
    handleRunStarted({ ...data, threadId });
  },
  'automation:run_completed': (threadId, data) => {
    handleRunCompleted({ ...data, threadId });
  },
  'automation:run_updated': (_threadId, data) => {
    handleRunUpdated(data);
  },
  'watcher:created': upsertWatcher,
  'watcher:fired': upsertWatcher,
  'watcher:rescheduled': upsertWatcher,
  'watcher:completed': upsertWatcher,
  'watcher:cancelled': upsertWatcher,
  'job:created': upsertJob,
  'job:exited': upsertJob,
  'job:killed': upsertJob,
  'job:cancelled': upsertJob,
  'pipeline:run_started': (_threadId, data) => {
    withPipelineStore((store) => store.handlePipelineStarted(data));
  },
  'pipeline:stage_update': (_threadId, data) => {
    withPipelineStore((store) => store.handlePipelineStageUpdate(data));
  },
  'pipeline:run_completed': (_threadId, data) => {
    withPipelineStore((store) => store.handlePipelineCompleted(data));
  },
  'pipeline:approval_requested': (_threadId, data) => {
    applyApprovalRequested(data);
  },
  'pipeline:approval_resolved': (_threadId, data) => {
    applyApprovalResolved(data);
  },
  'workflow:node_state': (_threadId, data) => {
    import('@/stores/workflow-run-store').then(({ useWorkflowRunStore }) => {
      useWorkflowRunStore.getState().handleNodeState(data);
    });
  },
  'thread:created': handleThreadCreated,
  'thread:comment': handleThreadComment,
  'thread:comment_deleted': handleThreadCommentDeleted,
  'thread:stage-changed': handleThreadStageChanged,
  'thread:updated': handleThreadUpdated,
  // ── Thread sharing: presence + revoke ──────────────────────
  'presence:sync': (threadId, data) => {
    withPresenceStore((store) => store.setRoster(threadId, data.viewers ?? []));
  },
  'presence:join': handlePresenceJoin,
  'presence:leave': (threadId, data) => {
    withPresenceStore((store) => store.removeViewer(threadId, data.clientId));
  },
  'thread:share-revoked': handleShareRevoked,
  'thread:deleted': handleThreadDeleted,
  'thread:share-granted': () => {
    // A thread was just shared WITH us — pull it into "Shared with me".
    void useThreadStore.getState().loadSharedThreads();
  },
  'git:status': handleGitStatus,
  'git:refs-updated': handleGitRefsUpdated,
  'git:workflow_progress': (threadId, data) => handleGitWorkflowProgress(threadId, data),
  'thread:event': (threadId, data) => handleThreadEvent(threadId, data),
  'pty:data': (_threadId, data) => {
    useTerminalStore.getState().emitPtyData(data.ptyId, data.data);
  },
  'pty:exit': (_threadId, data) => {
    useTerminalStore.getState().removeTab(data.ptyId);
  },
  'pty:error': (_threadId, data) => {
    // The server or runner restarted and forgot this terminal while its shell
    // lives on: re-attach instead of marking the tab dead.
    if (isTerminalSessionUnavailable(data.error) && notifyPtySessionLost(data.ptyId)) return;
    useTerminalStore.getState().setTabError(data.ptyId, data.error ?? 'Failed to create terminal');
  },
  'runner:status': (_threadId, data) => handleRunnerStatus(data),
  'pty:env_activated': noop,
  'thread:queue_update': (threadId, data) => {
    useThreadStore.getState().handleWSQueueUpdate(threadId, data);
  },
  'test:frame': testEventHandler,
  'test:output': testEventHandler,
  'test:status': testEventHandler,
  'test:console': testEventHandler,
  'test:network': testEventHandler,
  'test:error': testEventHandler,
  'test:action': testEventHandler,
  'clone:progress': noop,
  'activity:updated': (_threadId, data) => {
    const outcome = applyActivityUpdated(data);
    if (outcome?.becameFailed) notifyActivityFailed(outcome.activity);
    // A clone can outlive the screen that started it: show its project anyway.
    if (outcome?.createdProjectId) void useProjectStore.getState().loadProjects();
  },
  'activity:removed': (_threadId, data) => applyActivitiesRemoved(data),
  'activity:progress': (_threadId, data) => applyActivityProgress(data),
  'factory:setup_updated': (_threadId, data) => applyFactorySetupUpdated(data),
  'worktree:setup': (threadId, data) => {
    useThreadStore.getState().handleWSWorktreeSetup(threadId, data);
  },
  'worktree:setup_complete': (threadId, data) => {
    useThreadStore.getState().handleWSWorktreeSetupComplete(threadId, data);
  },
};

function isWebEventType(type: string): type is WebEventType {
  return Object.hasOwn(WEB_EVENT_HANDLERS, type);
}

function applyWebEvent(type: string, threadId: string, data: any): void {
  if (!isWebEventType(type)) return;
  WEB_EVENT_HANDLERS[type](threadId, data, type);
}

// ── Raw WS message handler (for remote containers) ──────────────

function handleRawMessage(e: MessageEvent) {
  const event = JSON.parse(e.data);
  const { type, threadId, data } = event;
  dispatchEvent(type, threadId, data);
}

// ── Socket.IO event registration ────────────────────────────────

const ALL_EVENT_TYPES = [
  'agent:message',
  'agent:tool_output',
  'agent:check_run',
  'agent:init',
  'agent:status',
  'agent:result',
  'agent:tool_call',
  'agent:error',
  'agent:compact_boundary',
  'agent:context_usage',
  'agent:account',
  'command:output',
  'command:status',
  'command:metrics',
  'automation:run_started',
  'automation:run_completed',
  'automation:run_updated',
  'watcher:created',
  'watcher:fired',
  'watcher:rescheduled',
  'watcher:completed',
  'watcher:cancelled',
  'job:created',
  'job:exited',
  'job:killed',
  'job:cancelled',
  'pipeline:run_started',
  'pipeline:stage_update',
  'pipeline:run_completed',
  'pipeline:approval_requested',
  'pipeline:approval_resolved',
  'workflow:node_state',
  'thread:created',
  'thread:comment',
  'thread:comment_deleted',
  'thread:stage-changed',
  'thread:updated',
  // Thread sharing — presence + revoke
  'presence:sync',
  'presence:join',
  'presence:leave',
  'thread:share-revoked',
  'thread:share-granted',
  'thread:deleted',
  'git:status',
  'git:refs-updated',
  'git:workflow_progress',
  'thread:event',
  'pty:data',
  'pty:exit',
  'pty:error',
  'pty:env_activated',
  'thread:queue_update',
  'test:frame',
  'test:output',
  'test:status',
  'test:console',
  'test:network',
  'test:error',
  'test:action',
  'clone:progress',
  'activity:updated',
  'activity:removed',
  'activity:progress',
  'factory:setup_updated',
  'worktree:setup',
  'worktree:setup_complete',
  'native-git:build_output',
  'native-git:build_status',
  'runner:status',
] as const;

// Tracks Socket.IO listeners we attached, so HMR (or any future dispose path)
// can detach them. Without this, every HMR replacement of this module leaves
// a ghost handler attached to the same socket — and the old handler closes
// over the OLD module's `pendingMessages` / `lastStatusByThread` / store
// reference, producing duplicate `agent:message received` logs and
// `activeMatch=false` artifacts during dev. (Not a prod problem, but it
// poisons debugging.)
const registeredSockets = new Map<Socket, Array<{ event: string; handler: (e: any) => void }>>();

export function registerSocketIOHandlers(socket: Socket): void {
  const attached: Array<{ event: string; handler: (e: any) => void }> = [];
  for (const eventType of ALL_EVENT_TYPES) {
    const handler = (eventData: any) => {
      const threadId = eventData.threadId ?? '';
      const data = eventData.data ?? eventData;
      dispatchEvent(eventType, threadId, data);
    };
    socket.on(eventType, handler);
    attached.push({ event: eventType, handler });
  }
  registeredSockets.set(socket, attached);
}

export function unregisterSocketIOHandlers(socket: Socket): void {
  const attached = registeredSockets.get(socket);
  if (!attached) return;
  for (const { event, handler } of attached) {
    socket.off(event, handler);
  }
  registeredSockets.delete(socket);
}

function unregisterAllSocketIOHandlers(): void {
  for (const [socket] of registeredSockets) {
    unregisterSocketIOHandlers(socket);
  }
}

// ── Remote WS management ─────────────────────────────────────────

export function connectRemoteWS(containerUrl: string) {
  if (stopped || remoteConnections.has(containerUrl)) return;

  const safeOrigin = validateContainerUrl(containerUrl);
  if (!safeOrigin) {
    wsLog.warn('refusing remote WS — invalid containerUrl', { containerUrl });
    return;
  }

  const wsUrl = `${safeOrigin.replace(/^http/, 'ws')}/ws`;
  wsLog.info('connecting remote WS', { containerUrl: safeOrigin });

  const ws = new WebSocket(wsUrl);
  remoteConnections.set(containerUrl, ws);

  ws.onopen = () => {
    wsLog.info('remote WS connected', { containerUrl });
  };

  ws.onmessage = handleRawMessage;

  ws.onclose = () => {
    remoteConnections.delete(containerUrl);
    if (stopped) return;
    const timer = setTimeout(() => {
      remoteReconnectTimers.delete(containerUrl);
      const active = useThreadStore.getState().activeThread;
      if (active?.runtime === 'remote' && active?.containerUrl === containerUrl) {
        connectRemoteWS(containerUrl);
      }
    }, 3000);
    remoteReconnectTimers.set(containerUrl, timer);
  };

  ws.onerror = () => {
    ws.close();
  };
}

export function disconnectRemoteWS(containerUrl: string) {
  const timer = remoteReconnectTimers.get(containerUrl);
  if (timer) {
    clearTimeout(timer);
    remoteReconnectTimers.delete(containerUrl);
  }
  const ws = remoteConnections.get(containerUrl);
  if (ws) {
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    remoteConnections.delete(containerUrl);
  }
}

export function disconnectAllRemote() {
  for (const url of [...remoteConnections.keys()]) {
    disconnectRemoteWS(url);
  }
}

/** Reset all batching + dedup state. Called by useWS teardown. */
export function clearWSDispatchState(): void {
  cancelScheduledFlush();
  pendingMessages.clear();
  pendingToolOutputs = [];
  pendingStatuses.clear();
  pendingOrdered = [];
  lastStatusByThread.clear();
}

/** Toggle the "stopped" flag so reconnect attempts halt during teardown. */
export function setWSStopped(value: boolean): void {
  stopped = value;
}

// ── HMR cleanup ─────────────────────────────────────────────────
// Vite re-evaluates this module on hot updates. Without an explicit dispose,
// the previous module instance keeps its socket.on listeners attached, its
// own pendingMessages map, and its own reference to useThreadStore. The
// result during dev is ghost handlers running in parallel with the live
// ones — exact symptom we hunted: duplicate `agent:message received` logs,
// `activeMatch=false` from a handler closed over a stale store snapshot,
// and "final response not shown" right after a save.
//
// This block is dev-only; in production Vite strips `import.meta.hot`.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    setWSStopped(true);
    unregisterAllSocketIOHandlers();
    disconnectAllRemote();
    clearWSDispatchState();
  });
}
