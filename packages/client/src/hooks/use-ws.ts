import { useEffect, startTransition } from 'react';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';

import { closePreviewForCommand } from '@/hooks/use-preview-window';
import { createClientLogger } from '@/lib/client-logger';
import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';
import { useGitStatusStore, invalidateCooldownsForKeys } from '@/stores/git-status-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useThreadStore } from '@/stores/thread-store';

const wsLog = createClientLogger('ws');

// Module-level singleton to prevent duplicate connections
// (React StrictMode double-mounts effects in development)
let activeSocket: Socket | null = null;
let refCount = 0;
let _wasConnected = false;
let stopped = false;

// ── Remote container WS connections ─────────────────────────────
// For threads with runtime === 'remote', we open a secondary WS to the
// container's server. Events from remote WS use the same handleMessage
// dispatcher — they carry threadId so stores route them correctly.
const remoteConnections = new Map<string, WebSocket>(); // containerUrl → ws
const remoteReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── WS message batching ─────────────────────────────────────────
// Rapid updates (e.g. streaming tokens) can overwhelm React with
// constant re-renders. We batch high-frequency events and flush
// them once per animation frame.

interface BufferedMessage {
  threadId: string;
  data: any;
}

let pendingMessages = new Map<string, BufferedMessage>(); // threadId → latest message
let pendingToolOutputs: Array<{ threadId: string; data: any }> = [];
let pendingStatuses = new Map<string, BufferedMessage>(); // threadId → latest status
let rafId: number | null = null;

// ── agent:status dedup ──────────────────────────────────────────
// The server sometimes emits identical agent:status events within the same
// millisecond. We keep the last status per thread and skip duplicates to
// avoid unnecessary Zustand store updates and cascading re-renders.
const lastStatusByThread = new Map<string, string>(); // threadId → serialized key

/** Tool names that are likely to modify files on disk. */
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
    // Flush statuses first so message handlers see up-to-date thread state
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

// ── Event handler registration ──────────────────────────────────

/**
 * Dispatch a received event (from Socket.IO or raw WS) to the appropriate store.
 * The event object has { type, threadId, data } shape.
 */
function dispatchEvent(type: string, threadId: string, data: any): void {
  switch (type) {
    // High-frequency events → batched
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
      // Dedup: skip if this is the exact same status we already processed
      const statusKey = `${data.status}|${data.waitingReason ?? ''}|${data.permissionRequest?.toolName ?? ''}|${data.stage ?? ''}|${data.permissionMode ?? ''}`;
      const prev = lastStatusByThread.get(threadId);
      if (prev === statusKey) break; // duplicate — skip
      lastStatusByThread.set(threadId, statusKey);

      wsLog.info('agent:status', {
        threadId,
        status: data.status,
        waitingReason: data.waitingReason ?? '',
        permissionRequest: data.permissionRequest?.toolName ?? '',
      });

      // Waiting/permission statuses need immediate processing for UX responsiveness
      // (user sees the permission dialog without delay). Other statuses are batched.
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
      // Clear status dedup cache — the agent run finished, next run should
      // process statuses fresh even if they repeat the same values.
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

      requestAnimationFrame(() => {
        startTransition(() => {
          useThreadStore.getState().handleWSResult(threadId, data);
        });
      });

      import('@/stores/review-pane-store').then(({ useReviewPaneStore }) => {
        useReviewPaneStore.getState().notifyDirty(threadId);
      });
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
      const termStore = useTerminalStore.getState();
      termStore.appendCommandOutput(data.commandId, data.data);
      break;
    }
    case 'command:status': {
      const termStore2 = useTerminalStore.getState();
      if (data.status === 'exited' || data.status === 'stopped') {
        termStore2.markCommandExited(data.commandId);
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
    case 'automation:run_started': {
      import('@/stores/automation-store').then(({ useAutomationStore }) => {
        useAutomationStore.getState().handleRunStarted({ ...data, threadId });
      });
      break;
    }
    case 'automation:run_completed': {
      import('@/stores/automation-store').then(({ useAutomationStore }) => {
        useAutomationStore.getState().handleRunCompleted(data);
      });
      break;
    }
    case 'automation:run_updated': {
      import('@/stores/automation-store').then(({ useAutomationStore }) => {
        useAutomationStore.getState().loadInbox();
      });
      break;
    }
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
    case 'thread:created': {
      useThreadStore.getState().loadThreadsForProject(data.projectId);
      break;
    }
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
        // Update the thread in the sidebar list (includes post-merge cleanup)
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
      // Reset cooldowns for the updated branch keys so subsequent fetches
      // are not throttled — the server just sent fresh data.
      const updatedKeys = (data.statuses as Array<{ branchKey: string }>).map((s) => s.branchKey);
      if (updatedKeys.length > 0) invalidateCooldownsForKeys(updatedKeys);
      import('@/stores/review-pane-store').then(({ useReviewPaneStore }) => {
        useReviewPaneStore.getState().notifyDirty(threadId);
      });
      break;
    }
    case 'git:workflow_progress': {
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
          // Show success toast for push workflows (covers both ReviewPane and CommitHistoryTab triggers)
          if (action === 'push') {
            toast.success('Pushed successfully');
          }
          setTimeout(() => store.finishCommit(threadId), 1500);
        } else if (wfStatus === 'failed') {
          store.replaceSteps(threadId, steps);
          // Show the full error in a modal instead of a generic toast
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
      // Invalidate PR detail cache after PR-related actions complete
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
      break;
    }
    case 'thread:event': {
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
      break;
    }
    case 'pty:data': {
      const termStore3 = useTerminalStore.getState();
      termStore3.emitPtyData(data.ptyId, data.data);
      break;
    }
    case 'pty:exit': {
      const termStore4 = useTerminalStore.getState();
      termStore4.markExited(data.ptyId);
      break;
    }
    case 'pty:error': {
      const termStore5 = useTerminalStore.getState();
      termStore5.setTabError(data.ptyId, data.error ?? 'Failed to create terminal');
      toast.error(data.error ?? 'Failed to create terminal');
      break;
    }
    case 'pty:sessions': {
      if (data.sessions && data.sessions.length > 0) {
        import('@/stores/project-store').then(({ useProjectStore }) => {
          const tryRestore = () => {
            const projects = useProjectStore.getState().projects;
            const termStore6 = useTerminalStore.getState();
            // restoreTabs atomically updates tabs AND marks sessionsChecked
            // in a single set() call — avoids intermediate state flickers
            // that would cancel in-flight spawn retry timers for other tabs.
            termStore6.restoreTabs(
              data.sessions,
              projects.map((p: any) => ({ id: p.id, path: p.path })),
            );
          };

          const projects = useProjectStore.getState().projects;
          if (projects.length > 0) {
            tryRestore();
          } else {
            const unsub = useProjectStore.subscribe((state) => {
              if (state.projects.length > 0) {
                unsub();
                tryRestore();
              }
            });
            setTimeout(() => {
              unsub();
              tryRestore();
            }, 10000);
          }
        });
      } else {
        useTerminalStore.getState().markSessionsChecked();
      }
      break;
    }
    case 'thread:queue_update': {
      useThreadStore.getState().handleWSQueueUpdate(threadId, data);
      break;
    }
    case 'test:frame': {
      import('@/components/test-runner/BrowserPreview').then(({ renderFrame }) => {
        renderFrame(data.data);
      });
      import('@/stores/test-store').then(({ useTestStore }) => {
        useTestStore.getState().addFrameToHistory(data.data, data.timestamp);
      });
      break;
    }
    case 'test:output': {
      import('@/stores/test-store').then(({ useTestStore }) => {
        useTestStore.getState().handleTestOutput(data);
      });
      break;
    }
    case 'test:status': {
      import('@/stores/test-store').then(({ useTestStore }) => {
        useTestStore.getState().handleTestStatus(data);
      });
      break;
    }
    case 'test:console': {
      import('@/stores/test-store').then(({ useTestStore }) => {
        useTestStore.getState().handleTestConsole(data);
      });
      break;
    }
    case 'test:network': {
      import('@/stores/test-store').then(({ useTestStore }) => {
        useTestStore.getState().handleTestNetwork(data);
      });
      break;
    }
    case 'test:error': {
      import('@/stores/test-store').then(({ useTestStore }) => {
        useTestStore.getState().handleTestError(data);
      });
      break;
    }
    case 'test:action': {
      import('@/stores/test-store').then(({ useTestStore }) => {
        useTestStore.getState().handleTestAction(data);
      });
      break;
    }
    case 'clone:progress': {
      window.dispatchEvent(new CustomEvent('clone:progress', { detail: data }));
      break;
    }
    case 'worktree:setup': {
      window.dispatchEvent(new CustomEvent('worktree:setup', { detail: { threadId, ...data } }));
      useThreadStore.getState().handleWSWorktreeSetup(threadId, data);
      break;
    }
    case 'worktree:setup_complete': {
      useThreadStore.getState().handleWSWorktreeSetupComplete(threadId, data);
      break;
    }
  }
}

// ── Raw WS message handler (for remote containers) ──────────────

function handleRawMessage(e: MessageEvent) {
  const event = JSON.parse(e.data);
  const { type, threadId, data } = event;
  dispatchEvent(type, threadId, data);
}

// ── Socket.IO event registration ────────────────────────────────

/** All event types that the server can emit to browser clients. */
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
  'thread:created',
  'thread:comment_deleted',
  'thread:updated',
  'git:status',
  'git:workflow_progress',
  'thread:event',
  'pty:data',
  'pty:exit',
  'pty:error',
  'pty:sessions',
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
];

function registerSocketIOHandlers(socket: Socket): void {
  for (const eventType of ALL_EVENT_TYPES) {
    socket.on(eventType, (eventData: any) => {
      // Socket.IO events carry the full event object (with threadId and data)
      const threadId = eventData.threadId ?? '';
      const data = eventData.data ?? eventData;
      dispatchEvent(eventType, threadId, data);
    });
  }
}

// ── Remote WS management ─────────────────────────────────────────
// Remote containers still use raw WebSocket (they run standalone runtime)

export function connectRemoteWS(containerUrl: string) {
  if (stopped || remoteConnections.has(containerUrl)) return;

  const wsUrl = `${containerUrl.replace(/^http/, 'ws')}/ws`;
  wsLog.info('connecting remote WS', { containerUrl });

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

function disconnectAllRemote() {
  for (const url of [...remoteConnections.keys()]) {
    disconnectRemoteWS(url);
  }
}

// ── Main connection ──────────────────────────────────────────────

function connect() {
  if (stopped) return;

  const isTauri = !!(window as any).__TAURI_INTERNALS__;
  const serverPort = import.meta.env.VITE_SERVER_PORT || '3001';

  let url: string;
  if (isTauri) {
    url = `http://localhost:${serverPort}`;
  } else {
    url = window.location.origin;
  }

  const socket = io(url, {
    // Session cookie sent automatically
    withCredentials: true,
    // Socket.IO handles reconnection automatically
    reconnection: true,
    reconnectionDelay: 2_000,
    reconnectionDelayMax: 10_000,
    // Allow both transports
    transports: ['websocket', 'polling'],
  });

  activeSocket = socket;

  socket.on('connect', () => {
    wsLog.info('Socket.IO connected', {
      transport: socket.io.engine?.transport?.name ?? 'unknown',
    });

    // Reset circuit breaker
    useCircuitBreakerStore.getState().recordSuccess();
    // Refresh all loaded threads
    useThreadStore.getState().refreshAllLoadedThreads();
    // Re-sync git status — do NOT reset cooldowns; the increased cooldown (5s)
    // naturally throttles the thundering herd. WS git:status events will
    // invalidate specific keys when the server pushes fresh data.
    const loadedProjectIds = Object.keys(useThreadStore.getState().threadsByProject);
    for (const pid of loadedProjectIds) {
      useGitStatusStore.getState().fetchForProject(pid);
    }
    _wasConnected = true;

    // Reset sessions-checked flag for PTY tabs
    useTerminalStore.getState().resetSessionsChecked();

    // Request PTY sessions from server
    socket.emit('pty:list', {});
    const sessionsTimeout = setTimeout(() => {
      const termStore = useTerminalStore.getState();
      if (!termStore.sessionsChecked) {
        termStore.markSessionsChecked();
      }
    }, 15_000);
    socket.once('disconnect', () => clearTimeout(sessionsTimeout));
  });

  socket.on('disconnect', (reason) => {
    if (stopped) return;
    wsLog.info('Socket.IO disconnected', { reason });
    // If server forced disconnect (auth failed), trigger logout
    if (reason === 'io server disconnect') {
      import('@/stores/auth-store').then(({ useAuthStore }) => {
        useAuthStore.getState().logout();
      });
    }
    // Socket.IO auto-reconnects for other reasons
  });

  socket.on('connect_error', (err) => {
    wsLog.error('Socket.IO connect error', { error: err.message });
  });

  // Register all event handlers
  registerSocketIOHandlers(socket);
}

function teardown() {
  stopped = true;
  disconnectAllRemote();
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  pendingMessages.clear();
  pendingToolOutputs = [];
  pendingStatuses.clear();
  lastStatusByThread.clear();
  if (activeSocket) {
    activeSocket.disconnect();
    activeSocket = null;
  }
  _wasConnected = false;
}

export function useWS() {
  useEffect(() => {
    refCount++;
    if (refCount === 1) {
      stopped = false;
      connect();
    }

    // Subscribe to active thread changes to auto-manage remote WS connections
    let lastContainerUrl: string | undefined;
    const unsub = useThreadStore.subscribe((state) => {
      const thread = state.activeThread;
      const containerUrl = thread?.runtime === 'remote' ? thread.containerUrl : undefined;

      if (containerUrl === lastContainerUrl) return;

      if (lastContainerUrl) {
        disconnectRemoteWS(lastContainerUrl);
      }

      if (containerUrl) {
        connectRemoteWS(containerUrl);
      }

      lastContainerUrl = containerUrl;
    });

    return () => {
      unsub();
      refCount--;
      if (refCount === 0) {
        teardown();
      }
    };
  }, []);
}

/** Get the active Socket.IO instance (for sending messages from components) */
export function getActiveWS(): Socket | null {
  return activeSocket;
}
