import { startTransition } from 'react';
import type { Socket } from 'socket.io-client';
import { toast } from 'sonner';

import { showAgentNotification } from '@/hooks/use-notifications';
import { closePreviewForCommand } from '@/hooks/use-preview-window';
import { validateContainerUrl } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';
import { invalidateCooldownsForKeys, useGitStatusStore } from '@/stores/git-status-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useThreadStore } from '@/stores/thread-store';
import { getNavigate } from '@/stores/thread-store-internals';

import { dispatchTestEvent } from './dispatch-test-events';

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

let pendingMessages = new Map<string, BufferedMessage>();
let pendingToolOutputs: Array<{ threadId: string; data: any }> = [];
let pendingStatuses = new Map<string, BufferedMessage>();
let rafId: number | null = null;

// Server sometimes emits identical agent:status events back-to-back. Dedup
// per-thread so Zustand doesn't fire duplicate updates.
const lastStatusByThread = new Map<string, string>();

const FILE_MODIFYING_TOOLS = new Set(['Write', 'Edit', 'Bash']);

function flushBatch() {
  rafId = null;

  const msgs = Array.from(pendingMessages.values());
  const toolOutputs = pendingToolOutputs.slice();
  const statuses = Array.from(pendingStatuses.values());
  pendingMessages.clear();
  pendingToolOutputs = [];
  pendingStatuses.clear();

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
}

function scheduleFlush() {
  if (rafId === null) {
    rafId = requestAnimationFrame(flushBatch);
  }
}

/**
 * Dispatch a received event (from Socket.IO or raw WS) to the appropriate
 * store. The event object has { type, threadId, data } shape.
 */
function dispatchEvent(type: string, threadId: string, data: any): void {
  switch (type) {
    case 'agent:message':
      pendingMessages.set(threadId, { threadId, data });
      scheduleFlush();
      break;
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
      const statusKey = `${data.status}|${data.waitingReason ?? ''}|${data.permissionRequest?.toolName ?? ''}|${data.stage ?? ''}|${data.permissionMode ?? ''}`;
      const prev = lastStatusByThread.get(threadId);
      if (prev === statusKey) break;
      lastStatusByThread.set(threadId, statusKey);

      wsLog.info('agent:status', {
        threadId,
        status: data.status,
        waitingReason: data.waitingReason ?? '',
        permissionRequest: data.permissionRequest?.toolName ?? '',
      });

      if (data.status === 'waiting' || data.permissionRequest) {
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

      wsLog.info('agent:result', {
        threadId,
        status: data.status ?? '',
        cost: String(data.cost ?? ''),
        errorReason: data.errorReason ?? '',
        isWaiting: String(data.status === 'waiting'),
      });
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
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
      if (hasPendingTC && rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
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
    case 'thread:created':
      useThreadStore.getState().loadThreadsForProject(data.projectId);
      break;
    case 'thread:comment_deleted': {
      const store = useThreadStore.getState();
      if (store.activeThread?.id === threadId) {
        store.refreshActiveThread();
      }
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
        if (store2.activeThread?.id === threadId) {
          store2.refreshActiveThread();
        }
      }
      if (data.permissionMode && store2.activeThread?.id === threadId) {
        useThreadStore.setState({
          activeThread: { ...store2.activeThread, permissionMode: data.permissionMode },
        });
      }
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
} {
  const store = useThreadStore.getState();
  if (store.activeThread?.id === threadId) {
    return {
      title: store.activeThread.title,
      branch: store.activeThread.branch,
      projectId: store.activeThread.projectId,
    };
  }
  for (const [projectId, threads] of Object.entries(store.threadsByProject)) {
    const t = threads.find((th) => th.id === threadId);
    if (t) return { title: t.title, branch: t.branch, projectId };
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
    if (navigate && info.projectId) {
      navigate(buildPath(`/projects/${info.projectId}/threads/${threadId}`));
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
  'pipeline:run_started',
  'pipeline:stage_update',
  'pipeline:run_completed',
  'pipeline:approval_requested',
  'pipeline:approval_resolved',
  'thread:created',
  'thread:comment_deleted',
  'thread:updated',
  'git:status',
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
];

export function registerSocketIOHandlers(socket: Socket): void {
  for (const eventType of ALL_EVENT_TYPES) {
    socket.on(eventType, (eventData: any) => {
      const threadId = eventData.threadId ?? '';
      const data = eventData.data ?? eventData;
      dispatchEvent(eventType, threadId, data);
    });
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
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  pendingMessages.clear();
  pendingToolOutputs = [];
  pendingStatuses.clear();
  lastStatusByThread.clear();
}

/** Toggle the "stopped" flag so reconnect attempts halt during teardown. */
export function setWSStopped(value: boolean): void {
  stopped = value;
}
