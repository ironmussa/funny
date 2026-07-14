import { startTransition } from 'react';
import type { Socket } from 'socket.io-client';
import { toast } from 'sonner';

import { showAgentNotification } from '@/hooks/use-notifications';
import { closePreviewForCommand } from '@/hooks/use-preview-window';
import { validateContainerUrl } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { metric, startSpan } from '@/lib/telemetry';
import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { invalidateCooldownsForKeys, useGitStatusStore } from '@/stores/git-status-store';
import { useTerminalStore } from '@/stores/terminal-store';
import * as threadMutations from '@/stores/thread-mutations';
import { useThreadStore } from '@/stores/thread-store';
import { getNavigate, getUrlThreadId } from '@/stores/thread-store-internals';

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

  const msgs = Array.from(pendingMessages.values());
  const toolOutputs = pendingToolOutputs.slice();
  const statuses = Array.from(pendingStatuses.values());
  pendingMessages.clear();
  pendingToolOutputs = [];
  pendingStatuses.clear();

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
function dispatchEvent(type: string, threadId: string, data: any): void {
  switch (type) {
    case 'agent:message': {
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
      break;
    }
    case 'agent:tool_output':
      pendingToolOutputs.push({ threadId, data });
      scheduleFlush();
      break;

    case 'agent:init':
      startTransition(() => {
        useThreadStore.getState().handleWSInit(threadId, data);
      });
      break;
    case 'agent:status': {
      const statusKey = `${data.status}|${data.waitingReason ?? ''}|${data.permissionRequest?.toolName ?? ''}|${data.pendingPermissionRequest?.requestId ?? ''}|${data.permissionApprovalCapability?.kind ?? ''}|${data.permissionApprovalCapability?.transport ?? data.permissionApprovalCapability?.reason ?? ''}|${data.stage ?? ''}|${data.permissionMode ?? ''}`;
      const prev = lastStatusByThread.get(threadId);
      if (prev === statusKey) break;
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
      break;
    }
    case 'agent:result': {
      lastStatusByThread.delete(threadId);

      const resultStatus = String(data.status ?? '');
      wsLog.info('agent:result', {
        threadId,
        status: resultStatus,
        cost: String(data.cost ?? ''),
        errorReason: data.errorReason ?? '',
        isWaiting: String(data.status === 'waiting'),
      });
      // Permanent counter: lets us see in Abbacchio whether the result event
      // even reached the client. A stuck "loading" thread with no `ws.result`
      // sample means the event was dropped at the transport layer.
      metric('ws.result_received', 1, { attributes: { status: resultStatus } });
      // Permanent span: covers the gap between "event arrived" and "store
      // applied final state" — surfaces React 19 transition lag under load.
      const dispatchSpan = startSpan('ws.dispatch_result', {
        attributes: { status: resultStatus },
      });

      cancelScheduledFlush();
      const msgs = Array.from(pendingMessages.values());
      const toolOutputs = pendingToolOutputs.slice();
      const statuses2 = Array.from(pendingStatuses.values());
      pendingMessages.clear();
      pendingToolOutputs = [];
      pendingStatuses.clear();

      if (statuses2.length > 0 || msgs.length > 0 || toolOutputs.length > 0) {
        const store = useThreadStore.getState();
        for (const entry of statuses2) store.handleWSStatus(entry.threadId, entry.data);
        for (const entry of msgs) store.handleWSMessage(entry.threadId, entry.data);
        for (const entry of toolOutputs) store.handleWSToolOutput(entry.threadId, entry.data);
      }

      startTransition(() => {
        useThreadStore.getState().handleWSResult(threadId, data);
        dispatchSpan.end('OK');
      });

      import('@/stores/review-pane-store').then(({ useReviewPaneStore }) => {
        useReviewPaneStore.getState().notifyDirty(threadId);
      });

      maybeNotifyAgentResult(threadId, data);
      break;
    }
    case 'agent:tool_call': {
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
          const msgs2 = Array.from(pendingMessages.values());
          pendingMessages.clear();
          const store = useThreadStore.getState();
          for (const entry of msgs2) store.handleWSMessage(entry.threadId, entry.data);
        }
        useThreadStore.getState().handleWSToolCall(threadId, data);
      });
      if (FILE_MODIFYING_TOOLS.has(data.name)) {
        import('@/stores/review-pane-store').then(({ useReviewPaneStore }) => {
          useReviewPaneStore.getState().notifyDirty(threadId);
        });
      }
      break;
    }
    case 'agent:error':
      wsLog.error('agent:error', { threadId, error: data.error ?? 'unknown' });
      startTransition(() => {
        useThreadStore.getState().handleWSError(threadId, data);
      });
      break;
    case 'agent:compact_boundary':
      startTransition(() => {
        useThreadStore.getState().handleWSCompactBoundary(threadId, data);
      });
      break;
    case 'agent:context_usage':
      startTransition(() => {
        useThreadStore.getState().handleWSContextUsage(threadId, data);
      });
      break;
    case 'command:output': {
      useTerminalStore.getState().appendCommandOutput(data.commandId, data.data);
      break;
    }
    case 'command:status': {
      if (data.status === 'exited' || data.status === 'stopped') {
        useTerminalStore.getState().markCommandExited(data.commandId);
        closePreviewForCommand(data.commandId);
      }
      break;
    }
    case 'command:metrics': {
      useTerminalStore.getState().updateCommandMetrics(data);
      break;
    }
    case 'native-git:build_output':
    case 'native-git:build_status': {
      import('@/stores/native-git-store').then(({ useNativeGitStore }) => {
        const store = useNativeGitStore.getState();
        if (type === 'native-git:build_output') {
          store.appendBuildOutput(data.text);
        } else {
          store.setBuildStatus(data.status, data.exitCode);
        }
      });
      break;
    }
    case 'automation:run_started':
      import('@/stores/automation-store').then(({ useAutomationStore }) => {
        useAutomationStore.getState().handleRunStarted({ ...data, threadId });
      });
      break;
    case 'automation:run_completed':
      import('@/stores/automation-store').then(({ useAutomationStore }) => {
        useAutomationStore.getState().handleRunCompleted(data);
      });
      break;
    case 'automation:run_updated':
      import('@/stores/automation-store').then(({ useAutomationStore }) => {
        useAutomationStore.getState().loadInbox();
      });
      break;
    case 'watcher:created':
    case 'watcher:fired':
    case 'watcher:rescheduled':
    case 'watcher:completed':
    case 'watcher:cancelled':
      import('@/stores/watcher-store').then(({ useWatcherStore }) => {
        if (data?.watcher) useWatcherStore.getState().upsert(data.watcher);
      });
      break;
    case 'job:created':
    case 'job:exited':
    case 'job:killed':
    case 'job:cancelled':
      import('@/stores/job-store').then(({ useJobStore }) => {
        if (data?.job) useJobStore.getState().upsert(data.job);
      });
      break;
    case 'pipeline:run_started':
    case 'pipeline:stage_update':
    case 'pipeline:run_completed': {
      import('@/stores/pipeline-store').then(({ usePipelineStore }) => {
        const store = usePipelineStore.getState();
        if (type === 'pipeline:run_started') store.handlePipelineStarted(data);
        else if (type === 'pipeline:stage_update') store.handlePipelineStageUpdate(data);
        else if (type === 'pipeline:run_completed') store.handlePipelineCompleted(data);
      });
      break;
    }
    case 'pipeline:approval_requested':
    case 'pipeline:approval_resolved': {
      import('@/stores/pipeline-approval-store').then(({ usePipelineApprovalStore }) => {
        const store = usePipelineApprovalStore.getState();
        if (type === 'pipeline:approval_requested') store.handleApprovalRequested(data);
        else store.handleApprovalResolved(data);
      });
      break;
    }
    case 'workflow:node_state': {
      import('@/stores/workflow-run-store').then(({ useWorkflowRunStore }) => {
        useWorkflowRunStore.getState().handleNodeState(data);
      });
      break;
    }
    case 'thread:claimed': {
      import('@/stores/scheduler-store').then(({ useSchedulerStore }) => {
        useSchedulerStore.getState().handleClaimed(threadId, data);
      });
      break;
    }
    case 'thread:dispatched': {
      import('@/stores/scheduler-store').then(({ useSchedulerStore }) => {
        useSchedulerStore.getState().handleDispatched(threadId, data);
      });
      break;
    }
    case 'thread:retry-queued': {
      import('@/stores/scheduler-store').then(({ useSchedulerStore }) => {
        useSchedulerStore.getState().handleRetryQueued(threadId, data);
      });
      break;
    }
    case 'thread:released': {
      import('@/stores/scheduler-store').then(({ useSchedulerStore }) => {
        useSchedulerStore.getState().handleReleased(threadId);
      });
      break;
    }
    case 'thread:created':
      // Scratch threads have no project (projectId is '' / null). Calling
      // loadThreadsForProject('') would fall through to api.listThreads()
      // with no filter, leaking every user thread into threadsByProject['']
      // and duplicating the sidebar Activity section. Scratch threads are
      // handled separately via addScratchThread on the create path.
      if (data.projectId) {
        useThreadStore.getState().loadThreadsForProject(data.projectId);
      }
      break;
    case 'thread:comment': {
      // A new comment was posted — append it live for every current viewer and
      // bump the header badge. See thread-sharing design D9.
      if (data.comment) {
        import('@/stores/comment-store').then(({ useCommentStore }) => {
          useCommentStore.getState().applyAdded(threadId, data.comment);
        });
        adjustCommentCount(threadId, +1);
      }
      break;
    }
    case 'thread:comment_deleted': {
      if (data.commentId) {
        import('@/stores/comment-store').then(({ useCommentStore }) => {
          useCommentStore.getState().applyDeleted(threadId, data.commentId);
        });
        adjustCommentCount(threadId, -1);
      } else {
        // Legacy payload without an id — fall back to a refetch.
        const store = useThreadStore.getState();
        if ((getUrlThreadId() ?? store.selectedThreadId) === threadId) {
          store.refreshActiveThread();
        }
      }
      break;
    }
    case 'thread:stage-changed': {
      useThreadStore.getState().handleWSStageChanged(threadId, {
        fromStage: data.fromStage ?? null,
        toStage: data.toStage,
        projectId: data.projectId,
      });
      break;
    }
    case 'thread:updated': {
      const store2 = useThreadStore.getState();
      if (data.status) {
        store2.handleWSStatus(threadId, { status: data.status });
      }
      if (data.archived) {
        store2.refreshAllLoadedThreads();
      }
      if (data.branch || data.worktreePath || data.containerUrl || data.mergedAt || data.mode) {
        store2.refreshAllLoadedThreads();
        if ((getUrlThreadId() ?? store2.selectedThreadId) === threadId) {
          store2.refreshActiveThread();
        }
      }
      if (data.permissionMode) {
        useThreadStore.setState((state) => ({
          ...threadMutations.patchThread(state, threadId, (thread) => ({
            ...thread,
            permissionMode: data.permissionMode,
          })),
          ...threadMutations.applyThreadDataPatch(state, threadId, (thread) => ({
            ...thread,
            permissionMode: data.permissionMode,
          })),
          // A very early event can arrive before either cache is hydrated.
          // Keep the active mirror coherent in that narrow window as well.
          ...(state.activeThread?.id === threadId &&
          !state.threadsById[threadId] &&
          !state.threadDataById[threadId]
            ? { activeThread: { ...state.activeThread, permissionMode: data.permissionMode } }
            : {}),
        }));
      }
      break;
    }
    // ── Thread sharing: presence + revoke ──────────────────────
    case 'presence:sync': {
      import('@/stores/presence-store').then(({ usePresenceStore }) => {
        usePresenceStore.getState().setRoster(threadId, data.viewers ?? []);
      });
      break;
    }
    case 'presence:join': {
      if (data.viewer) {
        import('@/stores/presence-store').then(({ usePresenceStore }) => {
          usePresenceStore.getState().upsertViewer(threadId, data.viewer);
        });
      }
      break;
    }
    case 'presence:leave': {
      import('@/stores/presence-store').then(({ usePresenceStore }) => {
        usePresenceStore.getState().removeViewer(threadId, data.clientId);
      });
      break;
    }
    case 'thread:share-revoked': {
      // The owner revoked our access — drop the thread + its presence.
      import('@/stores/presence-store').then(({ usePresenceStore }) => {
        usePresenceStore.getState().clearThread(threadId);
      });
      useThreadStore.getState().handleShareRevoked(threadId);
      break;
    }
    case 'thread:share-granted': {
      // A thread was just shared WITH us — pull it into "Shared with me".
      void useThreadStore.getState().loadSharedThreads();
      break;
    }
    case 'git:status': {
      useGitStatusStore.getState().updateFromWS(data.statuses);
      const updatedKeys = (data.statuses as Array<{ branchKey: string }>).map((s) => s.branchKey);
      if (updatedKeys.length > 0) invalidateCooldownsForKeys(updatedKeys);
      import('@/stores/review-pane-store').then(({ useReviewPaneStore }) => {
        useReviewPaneStore.getState().notifyDirty(threadId);
      });
      break;
    }
    case 'git:refs-updated': {
      // A background `git fetch` advanced the remote-tracking refs (origin may
      // have new commits). Re-fetch status through the normal — now cache-fresh
      // — path so the incoming-commit count surfaces without a second manual
      // refresh. The store's staleness guard keeps a late stale response from
      // overwriting this fresh one.
      //
      // We refetch all three slices because only ONE status route wins the
      // per-project fetch throttle, and we can't know which: the thread route
      // pushes the active thread via `git:status` directly, but if the project
      // or bulk route won instead, the active thread badge would never update.
      // So force-refetch the active thread here too (cheap, ≤once/30s/project).
      const gitStore = useGitStatusStore.getState();
      // Clear cooldowns so the bulk sidebar refetch isn't swallowed by its window.
      invalidateCooldownsForKeys([data.projectId]);
      const activeThreadId = getUrlThreadId() ?? useThreadStore.getState().selectedThreadId;
      if (activeThreadId) void gitStore.fetchForThread(activeThreadId, true); // thread-mode pane
      void gitStore.fetchProjectStatus(data.projectId, true); // project-mode pane slice
      void gitStore.fetchForProject(data.projectId); // sidebar bulk badges
      break;
    }
    case 'git:workflow_progress': {
      handleGitWorkflowProgress(threadId, data);
      break;
    }
    case 'thread:event':
      handleThreadEvent(threadId, data);
      break;
    case 'pty:data': {
      useTerminalStore.getState().emitPtyData(data.ptyId, data.data);
      break;
    }
    case 'pty:exit': {
      useTerminalStore.getState().removeTab(data.ptyId);
      break;
    }
    case 'pty:error': {
      useTerminalStore
        .getState()
        .setTabError(data.ptyId, data.error ?? 'Failed to create terminal');
      toast.error(data.error ?? 'Failed to create terminal');
      break;
    }
    case 'runner:status':
      handleRunnerStatus(data);
      break;
    case 'pty:env_activated': {
      const lines = (data.activations as Array<{ kind: string; detail: string }>).map(
        (a) => `${a.kind}: ${a.detail}`,
      );
      toast.success('Activated environment', {
        description: lines.join('\n'),
      });
      break;
    }
    case 'thread:queue_update':
      useThreadStore.getState().handleWSQueueUpdate(threadId, data);
      break;
    case 'test:frame':
    case 'test:output':
    case 'test:status':
    case 'test:console':
    case 'test:network':
    case 'test:error':
    case 'test:action':
      dispatchTestEvent(type, data);
      break;
    case 'browser-session:frame':
    case 'browser-session:ready':
    case 'browser-session:result':
    case 'browser-session:console':
    case 'browser-session:error':
    case 'browser-session:closed':
      dispatchBrowserSessionEvent(type, data);
      break;
    case 'clone:progress':
      window.dispatchEvent(new CustomEvent('clone:progress', { detail: data }));
      break;
    case 'worktree:setup':
      window.dispatchEvent(new CustomEvent('worktree:setup', { detail: { threadId, ...data } }));
      useThreadStore.getState().handleWSWorktreeSetup(threadId, data);
      break;
    case 'worktree:setup_complete':
      useThreadStore.getState().handleWSWorktreeSetupComplete(threadId, data);
      break;
  }
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
      onClick,
    });
  } else if (status === 'failed' || status === 'error') {
    const reason = data.errorReason ? ` — ${data.errorReason}` : '';
    showAgentNotification(title, `Agent failed${reason}`, {
      tag: `agent-result-${threadId}`,
      skipIfViewingThreadId: threadId,
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
      const failedHook = steps?.find((s: any) => s.id === 'hooks' && s.status === 'failed');
      if (failedHook) {
        toast.error('Pre-commit hook failed', {
          description: failedHook.error
            ? failedHook.error.slice(0, 120)
            : 'A pre-commit hook did not pass',
        });
      }
    } else if (wfStatus === 'completed') {
      store.replaceSteps(threadId, steps);
      if (action === 'push') {
        toast.success('Pushed successfully');
      }
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
];

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
