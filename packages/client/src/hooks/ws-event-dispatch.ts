import {
  createRealtimeDispatcher,
  type RealtimeActionPorts,
  type RealtimeEffect,
  type RealtimeEvent,
} from '@funny/client-core';
import { startTransition } from 'react';
import type { Socket } from 'socket.io-client';

import { showAgentNotification } from '@/hooks/use-notifications';
import { closePreviewForCommand } from '@/hooks/use-preview-window';
import { validateContainerUrl } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { metric, startSpan } from '@/lib/telemetry';
import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { clientComposition } from '@/platform/client-composition';
import { invalidateCooldownsForKeys, useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useTerminalStore } from '@/stores/terminal-store';
import * as threadMutations from '@/stores/thread-mutations';
import { useThreadStore } from '@/stores/thread-store';
import {
  getNavigate,
  getProjectIdForThread,
  getUrlThreadId,
} from '@/stores/thread-store-internals';

import { dispatchBrowserSessionEvent } from './dispatch-browser-session-events';
import { dispatchTestEvent } from './dispatch-test-events';

const wsLog = createClientLogger('ws');

/** Bump a thread's comment-count badge live (floored at 0). */
function adjustCommentCount(threadId: string, delta: number): void {
  useThreadStore.setState((state) =>
    threadMutations.patchThread(state, threadId, (t) => ({
      ...t,
      commentCount: Math.max(0, (t.commentCount ?? 0) + delta),
    })),
  );
}

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

  const { msgs, toolOutputs, statuses } = drainPendingBatch();

  const total = msgs.length + toolOutputs.length + statuses.length;
  if (total === 0) return;

  const span = startSpan('ws.flushBatch', {
    attributes: {
      'batch.messages': msgs.length,
      'batch.tool_outputs': toolOutputs.length,
      'batch.statuses': statuses.length,
    },
  });
  const t0 = performance.now();

  startTransition(() => {
    const store = useThreadStore.getState();
    for (const entry of statuses) {
      store.handleWSStatus(entry.threadId, entry.data);
    }
    for (const entry of msgs) {
      store.handleWSMessage(entry.threadId, entry.data);
    }
    for (const entry of toolOutputs) {
      store.handleWSToolOutput(entry.threadId, entry.data);
    }
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
  browserSession: applyThroughWebStore,
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
export function dispatchRealtimeEvent(type: string, threadId: string, data: unknown): void {
  dispatchEvent(type, threadId, data);
}

// ── Web event handlers (table-driven dispatch) ──────────────────

type WebEventType = (typeof ALL_EVENT_TYPES)[number];
type WebEventHandler = (threadId: string, data: any, type: string) => void;
type ThreadStoreState = ReturnType<typeof useThreadStore.getState>;

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

function notifyReviewDirty(threadId: string): void {
  import('@/stores/review-pane-store').then(({ useReviewPaneStore }) => {
    useReviewPaneStore.getState().notifyDirty(threadId);
  });
}

/** True when `threadId` is the thread the user is currently viewing. */
function isViewingThread(store: ThreadStoreState, threadId: string): boolean {
  return (getUrlThreadId() ?? store.selectedThreadId) === threadId;
}

function drainPendingBatch(): {
  msgs: BufferedMessage[];
  toolOutputs: Array<{ threadId: string; data: any }>;
  statuses: BufferedMessage[];
} {
  const msgs = Array.from(pendingMessages.values());
  const toolOutputs = pendingToolOutputs.slice();
  const statuses = Array.from(pendingStatuses.values());
  pendingMessages.clear();
  pendingToolOutputs = [];
  pendingStatuses.clear();
  return { msgs, toolOutputs, statuses };
}

function handleAgentMessage(threadId: string, data: any): void {
  const key = pendingMessageKey(threadId, data);
  const collapsed = pendingMessages.has(key);
  wsLog.info('agent:message received', {
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

  wsLog.info('agent:status', {
    threadId,
    status: data.status,
    waitingReason: data.waitingReason ?? '',
    permissionRequest: data.permissionRequest?.toolName ?? '',
  });

  if (data.status === 'waiting' || data.permissionRequest || data.pendingPermissionRequest) {
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
  const { msgs, toolOutputs, statuses } = drainPendingBatch();
  if (statuses.length === 0 && msgs.length === 0 && toolOutputs.length === 0) return;
  const store = useThreadStore.getState();
  for (const entry of statuses) store.handleWSStatus(entry.threadId, entry.data);
  for (const entry of msgs) store.handleWSMessage(entry.threadId, entry.data);
  for (const entry of toolOutputs) store.handleWSToolOutput(entry.threadId, entry.data);
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
  const hasPendingTC = pendingMessages.size > 0;
  if (hasPendingTC) cancelScheduledFlush();
  startTransition(() => {
    if (hasPendingTC) {
      const msgs = Array.from(pendingMessages.values());
      pendingMessages.clear();
      const store = useThreadStore.getState();
      for (const entry of msgs) store.handleWSMessage(entry.threadId, entry.data);
    }
    useThreadStore.getState().handleWSToolCall(threadId, data);
  });
  if (FILE_MODIFYING_TOOLS.has(data.name)) {
    notifyReviewDirty(threadId);
  }
}

function handleAgentError(threadId: string, data: any): void {
  wsLog.error('agent:error', { threadId, error: data.error ?? 'unknown' });
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

function upsertWatcher(_threadId: string, data: any): void {
  import('@/stores/watcher-store').then(({ useWatcherStore }) => {
    if (data?.watcher) useWatcherStore.getState().upsert(data.watcher);
  });
}

function upsertJob(_threadId: string, data: any): void {
  import('@/stores/job-store').then(({ useJobStore }) => {
    if (data?.job) useJobStore.getState().upsert(data.job);
  });
}

type AutomationStoreState = ReturnType<
  (typeof import('@/stores/automation-store'))['useAutomationStore']['getState']
>;
function withAutomationStore(apply: (store: AutomationStoreState) => void): void {
  import('@/stores/automation-store').then(({ useAutomationStore }) => {
    apply(useAutomationStore.getState());
  });
}

type PipelineStoreState = ReturnType<
  (typeof import('@/stores/pipeline-store'))['usePipelineStore']['getState']
>;
function withPipelineStore(apply: (store: PipelineStoreState) => void): void {
  import('@/stores/pipeline-store').then(({ usePipelineStore }) => {
    apply(usePipelineStore.getState());
  });
}

type PipelineApprovalStoreState = ReturnType<
  (typeof import('@/stores/pipeline-approval-store'))['usePipelineApprovalStore']['getState']
>;
function withPipelineApprovalStore(apply: (store: PipelineApprovalStoreState) => void): void {
  import('@/stores/pipeline-approval-store').then(({ usePipelineApprovalStore }) => {
    apply(usePipelineApprovalStore.getState());
  });
}

type SchedulerStoreState = ReturnType<
  (typeof import('@/stores/scheduler-store'))['useSchedulerStore']['getState']
>;
function withSchedulerStore(apply: (store: SchedulerStoreState) => void): void {
  import('@/stores/scheduler-store').then(({ useSchedulerStore }) => {
    apply(useSchedulerStore.getState());
  });
}

type PresenceStoreState = ReturnType<
  (typeof import('@/stores/presence-store'))['usePresenceStore']['getState']
>;
function withPresenceStore(apply: (store: PresenceStoreState) => void): void {
  import('@/stores/presence-store').then(({ usePresenceStore }) => {
    apply(usePresenceStore.getState());
  });
}

type CommentStoreState = ReturnType<
  (typeof import('@/stores/comment-store'))['useCommentStore']['getState']
>;
function withCommentStore(apply: (store: CommentStoreState) => void): void {
  import('@/stores/comment-store').then(({ useCommentStore }) => {
    apply(useCommentStore.getState());
  });
}

function handleThreadCreated(_threadId: string, data: any): void {
  // Scratch threads have no project (projectId is '' / null). Calling
  // loadThreadsForProject('') would fall through to api.listThreads()
  // with no filter, leaking every user thread into threadsByProject['']
  // and duplicating the sidebar Activity section. Scratch threads are
  // handled separately via addScratchThread on the create path.
  if (data.projectId) {
    useThreadStore.getState().loadThreadsForProject(data.projectId);
  }
}

function handleThreadComment(threadId: string, data: any): void {
  // A new comment was posted — append it live for every current viewer and
  // bump the header badge. See thread-sharing design D9.
  if (data.comment) {
    withCommentStore((store) => store.applyAdded(threadId, data.comment));
    adjustCommentCount(threadId, +1);
  }
}

function handleThreadCommentDeleted(threadId: string, data: any): void {
  if (data.commentId) {
    withCommentStore((store) => store.applyDeleted(threadId, data.commentId));
    adjustCommentCount(threadId, -1);
    return;
  }
  // Legacy payload without an id — fall back to a refetch.
  const store = useThreadStore.getState();
  if (isViewingThread(store, threadId)) {
    store.refreshActiveThread();
  }
}

function handleThreadStageChanged(threadId: string, data: any): void {
  useThreadStore.getState().handleWSStageChanged(threadId, {
    fromStage: data.fromStage ?? null,
    toStage: data.toStage,
    projectId: data.projectId,
  });
}

function hasLocationChange(data: any): boolean {
  return !!(data.branch || data.worktreePath || data.containerUrl || data.mergedAt || data.mode);
}

function patchPermissionMode(threadId: string, permissionMode: any): void {
  useThreadStore.setState((state) => ({
    ...threadMutations.patchThread(state, threadId, (thread) => ({
      ...thread,
      permissionMode,
    })),
    ...threadMutations.applyThreadDataPatch(state, threadId, (thread) => ({
      ...thread,
      permissionMode,
    })),
    // A very early event can arrive before either cache is hydrated.
    // Keep the active mirror coherent in that narrow window as well.
    ...(state.activeThread?.id === threadId &&
    !state.threadsById[threadId] &&
    !state.threadDataById[threadId]
      ? { activeThread: { ...state.activeThread, permissionMode } }
      : {}),
  }));
}

function handleThreadUpdated(threadId: string, data: any): void {
  const store = useThreadStore.getState();
  if (data.resync && isViewingThread(store, threadId)) {
    store.refreshActiveThread();
  }
  if (data.status) {
    store.handleWSStatus(threadId, { status: data.status });
  }
  if (data.archived) {
    store.refreshAllLoadedThreads();
  }
  if (hasLocationChange(data)) {
    store.refreshAllLoadedThreads();
    if (isViewingThread(store, threadId)) {
      store.refreshActiveThread();
    }
  }
  if (data.permissionMode) {
    patchPermissionMode(threadId, data.permissionMode);
  }
}

function handlePresenceJoin(threadId: string, data: any): void {
  if (data.viewer) {
    withPresenceStore((store) => store.upsertViewer(threadId, data.viewer));
  }
}

function handleShareRevoked(threadId: string): void {
  // The owner revoked our access — drop the thread + its presence.
  withPresenceStore((store) => store.clearThread(threadId));
  useThreadStore.getState().handleShareRevoked(threadId);
}

function handleGitStatus(threadId: string, data: any): void {
  useGitStatusStore.getState().updateFromWS(data.statuses);
  const updatedKeys = (data.statuses as Array<{ branchKey: string }>).map((s) => s.branchKey);
  if (updatedKeys.length > 0) invalidateCooldownsForKeys(updatedKeys);
  notifyReviewDirty(threadId);
}

function handleGitRefsUpdated(_threadId: string, data: any): void {
  // A background `git fetch` advanced the remote-tracking refs (origin may
  // have new commits). Re-fetch status through the normal — now cache-fresh
  // — path so the incoming-commit count surfaces without a second manual
  // refresh. The store's staleness guard keeps a late stale response from
  // overwriting this fresh one.
  //
  // Refresh the bulk slice for the project that emitted the event. The
  // thread/project-mode slices are only relevant when that same project is
  // active; refreshing them for unrelated repositories created a second
  // startup wave and repeatedly recomputed the same active-thread status.
  const gitStore = useGitStatusStore.getState();
  // Clear cooldowns so the bulk sidebar refetch isn't swallowed by its window.
  invalidateCooldownsForKeys([data.projectId]);
  const activeThreadId = getUrlThreadId() ?? useThreadStore.getState().selectedThreadId;
  const activeThreadProjectId = activeThreadId ? getProjectIdForThread(activeThreadId) : undefined;
  if (activeThreadId && activeThreadProjectId === data.projectId) {
    void gitStore.fetchForThread(activeThreadId, true); // thread-mode pane
  }
  if (useProjectStore.getState().selectedProjectId === data.projectId) {
    void gitStore.fetchProjectStatus(data.projectId, true); // project-mode pane slice
  }
  void gitStore.fetchForProject(data.projectId); // sidebar bulk badges
}

const testEventHandler: WebEventHandler = (_threadId, data, type) => {
  dispatchTestEvent(type, data);
};

const browserSessionEventHandler: WebEventHandler = (_threadId, data, type) => {
  dispatchBrowserSessionEvent(type, data);
};

/**
 * One handler per event type. Typed as a full `Record` over `ALL_EVENT_TYPES`
 * so registering a new Socket.IO event without a handler is a compile error.
 */
const WEB_EVENT_HANDLERS: Record<WebEventType, WebEventHandler> = {
  'agent:message': handleAgentMessage,
  'agent:tool_output': handleAgentToolOutput,
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
    withAutomationStore((store) => store.handleRunStarted({ ...data, threadId }));
  },
  'automation:run_completed': (_threadId, data) => {
    withAutomationStore((store) => store.handleRunCompleted(data));
  },
  'automation:run_updated': () => {
    withAutomationStore((store) => store.loadInbox());
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
    withPipelineApprovalStore((store) => store.handleApprovalRequested(data));
  },
  'pipeline:approval_resolved': (_threadId, data) => {
    withPipelineApprovalStore((store) => store.handleApprovalResolved(data));
  },
  'workflow:node_state': (_threadId, data) => {
    import('@/stores/workflow-run-store').then(({ useWorkflowRunStore }) => {
      useWorkflowRunStore.getState().handleNodeState(data);
    });
  },
  'thread:claimed': (threadId, data) => {
    withSchedulerStore((store) => store.handleClaimed(threadId, data));
  },
  'thread:dispatched': (threadId, data) => {
    withSchedulerStore((store) => store.handleDispatched(threadId, data));
  },
  'thread:retry-queued': (threadId, data) => {
    withSchedulerStore((store) => store.handleRetryQueued(threadId, data));
  },
  'thread:released': (threadId) => {
    withSchedulerStore((store) => store.handleReleased(threadId));
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
  'browser-session:frame': browserSessionEventHandler,
  'browser-session:ready': browserSessionEventHandler,
  'browser-session:result': browserSessionEventHandler,
  'browser-session:console': browserSessionEventHandler,
  'browser-session:error': browserSessionEventHandler,
  'browser-session:closed': browserSessionEventHandler,
  'clone:progress': noop,
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

function findThread(threadId: string): {
  title?: string;
  branch?: string;
  projectId?: string;
  isScratch?: boolean;
} {
  const store = useThreadStore.getState();
  if (store.activeThread?.id === threadId) {
    return {
      title: store.activeThread.title,
      branch: store.activeThread.branch,
      projectId: store.activeThread.projectId,
      isScratch: store.activeThread.isScratch,
    };
  }
  const t = store.threadsById[threadId];
  if (t) {
    return {
      title: t.title,
      branch: t.branch,
      projectId: t.projectId,
      isScratch: !!t.isScratch,
    };
  }
  return {};
}

function buildNotificationTitle(info: { title?: string; branch?: string }): string {
  const parts = ['funny'];
  if (info.branch) parts.push(info.branch);
  if (info.title) parts.push(info.title);
  return parts.join(' — ');
}

function maybeNotifyAgentResult(threadId: string, data: any): void {
  const status = data.status as string | undefined;
  const info = findThread(threadId);
  const title = buildNotificationTitle(info);
  const onClick = () => {
    const navigate = getNavigate();
    if (!navigate) return;
    if (info.isScratch) {
      navigate(buildPath(getThreadRoute({ id: threadId, projectId: '', isScratch: true })));
    } else if (info.projectId) {
      navigate(buildPath(getThreadRoute({ id: threadId, projectId: info.projectId })));
    }
  };
  if (status === 'completed') {
    showAgentNotification(title, 'Agent finished', {
      tag: `agent-result-${threadId}`,
      skipIfViewingThreadId: threadId,
      url: buildPath(
        getThreadRoute({
          id: threadId,
          projectId: info.projectId ?? '',
          isScratch: info.isScratch,
        }),
      ),
      onClick,
    });
  } else if (status === 'failed' || status === 'error') {
    const reason = data.errorReason ? ` — ${data.errorReason}` : '';
    showAgentNotification(title, `Agent failed${reason}`, {
      tag: `agent-result-${threadId}`,
      skipIfViewingThreadId: threadId,
      url: buildPath(
        getThreadRoute({
          id: threadId,
          projectId: info.projectId ?? '',
          isScratch: info.isScratch,
        }),
      ),
      onClick,
    });
  }
}

function handleGitWorkflowProgress(threadId: string, data: any) {
  import('@/stores/commit-progress-store').then(({ useCommitProgressStore }) => {
    const store = useCommitProgressStore.getState();
    const { status: wfStatus, title, action, steps, workflowId } = data;

    if (wfStatus === 'started') {
      store.startCommit(threadId, title, steps, action, workflowId);
    } else if (wfStatus === 'step_update') {
      store.replaceSteps(threadId, steps);
    } else if (wfStatus === 'completed') {
      store.replaceSteps(threadId, steps);
      setTimeout(() => store.finishCommit(threadId), 1500);
    } else if (wfStatus === 'failed') {
      store.replaceSteps(threadId, steps);
      store.setFailedWorkflow({
        title: title || 'Git operation failed',
        steps: steps ?? [],
        action: action ?? '',
      });
      store.finishCommit(threadId);
    }
  });

  if (data.status === 'completed' || data.status === 'failed') {
    import('@/stores/review-pane-store').then(({ useReviewPaneStore }) => {
      useReviewPaneStore.getState().notifyDirty(threadId);
    });
  }
  if (
    data.status === 'completed' &&
    (data.action === 'push' ||
      data.action === 'create-pr' ||
      data.action === 'commit-pr' ||
      data.action === 'commit-merge')
  ) {
    import('@/stores/pr-detail-store').then(({ usePRDetailStore }) => {
      const { activeThread } = useThreadStore.getState();
      if (activeThread) {
        const gitStatus = useGitStatusStore.getState();
        const bk =
          gitStatus.threadToBranchKey[activeThread.id] ??
          `${activeThread.projectId}:${activeThread.branch ?? ''}`;
        const prNum = gitStatus.statusByBranch[bk]?.prNumber;
        if (prNum) {
          usePRDetailStore.getState().invalidate(activeThread.projectId, prNum);
        }
      }
    });
  }
}

function handleThreadEvent(threadId: string, data: any) {
  startTransition(() => {
    const active = useThreadStore.getState().activeThread;
    if (active && active.id === threadId) {
      const existing = active.threadEvents ?? [];
      if (data.event?.id && existing.some((e: any) => e.id === data.event.id)) return;
      useThreadStore.setState({
        activeThread: {
          ...active,
          threadEvents: [...existing, data.event],
        },
      });
    }
  });
}

function handleRunnerStatus(data: any) {
  const status = data?.status;
  if (status !== 'online' && status !== 'offline') return;
  import('@/stores/runner-status-store').then(({ useRunnerStatusStore }) => {
    useRunnerStatusStore.getState().setStatus(status);
  });
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
  'agent:init',
  'agent:status',
  'agent:result',
  'agent:tool_call',
  'agent:error',
  'agent:compact_boundary',
  'agent:context_usage',
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
  'thread:claimed',
  'thread:dispatched',
  'thread:retry-queued',
  'thread:released',
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
  'worktree:setup',
  'worktree:setup_complete',
  'native-git:build_output',
  'native-git:build_status',
  'runner:status',
  'browser-session:ready',
  'browser-session:frame',
  'browser-session:result',
  'browser-session:console',
  'browser-session:error',
  'browser-session:closed',
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
