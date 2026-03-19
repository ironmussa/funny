import { useEffect, startTransition } from 'react';
import { toast } from 'sonner';

import { closePreviewForCommand } from '@/hooks/use-preview-window';
import { createClientLogger } from '@/lib/client-logger';
import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';
import { useGitStatusStore, _resetCooldowns } from '@/stores/git-status-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useThreadStore } from '@/stores/thread-store';

const wsLog = createClientLogger('ws');

// Module-level singleton to prevent duplicate WebSocket connections
// (React StrictMode double-mounts effects in development)
let activeWS: WebSocket | null = null;
let refCount = 0;
let _wasConnected = false;
let stopped = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// ── Remote container WS connections ─────────────────────────────
// For threads with runtime === 'remote', we open a secondary WS to the
// container's server. Events from remote WS use the same handleMessage
// dispatcher — they carry threadId so stores route them correctly.
const remoteConnections = new Map<string, WebSocket>(); // containerUrl → ws
const remoteReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── WS message batching ─────────────────────────────────────────
// Rapid WS updates (e.g. streaming tokens) can overwhelm React with
// constant re-renders. We batch high-frequency events (agent:message,
// agent:tool_output) and flush them once per animation frame.
// Low-frequency events (status, result, init, tool_call) are dispatched
// immediately so the UI stays responsive.

interface BufferedMessage {
  threadId: string;
  data: any;
}

let pendingMessages = new Map<string, BufferedMessage>(); // threadId → latest message
let pendingToolOutputs: Array<{ threadId: string; data: any }> = [];
let rafId: number | null = null;

/** Tool names that are likely to modify files on disk. */
const FILE_MODIFYING_TOOLS = new Set(['Write', 'Edit', 'Bash']);

function flushBatch() {
  rafId = null;

  // Capture batched data before clearing
  const msgs = Array.from(pendingMessages.values());
  const toolOutputs = pendingToolOutputs.slice();
  pendingMessages.clear();
  pendingToolOutputs = [];

  // Wrap in startTransition so React treats the resulting re-renders
  // as low-priority — user interactions (typing, clicks) can interrupt them.
  startTransition(() => {
    const store = useThreadStore.getState();

    // Flush messages (only the latest per thread — they're cumulative)
    for (const entry of msgs) {
      store.handleWSMessage(entry.threadId, entry.data);
    }

    // Flush tool outputs
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

// ── Message handler ──────────────────────────────────────────────

function handleMessage(e: MessageEvent) {
  const event = JSON.parse(e.data);
  const { type, threadId, data } = event;

  switch (type) {
    // High-frequency events → batched
    case 'agent:message':
      // Keep only the latest message per thread (they're cumulative)
      pendingMessages.set(threadId, { threadId, data });
      scheduleFlush();
      break;
    case 'agent:tool_output':
      pendingToolOutputs.push({ threadId, data });
      scheduleFlush();
      break;

    // Low-frequency events → wrapped in startTransition so they don't block
    // user interactions (e.g. opening a dropdown menu). React can interrupt
    // these updates if a higher-priority event (click, keypress) arrives.
    case 'agent:init':
      startTransition(() => {
        useThreadStore.getState().handleWSInit(threadId, data);
      });
      break;
    case 'agent:status':
      wsLog.info('agent:status', {
        threadId,
        status: data.status,
        waitingReason: data.waitingReason ?? '',
        permissionRequest: data.permissionRequest?.toolName ?? '',
      });
      startTransition(() => {
        useThreadStore.getState().handleWSStatus(threadId, data);
      });
      break;
    case 'agent:result': {
      wsLog.info('agent:result', {
        threadId,
        status: data.status ?? '',
        cost: String(data.cost ?? ''),
        errorReason: data.errorReason ?? '',
        isWaiting: String(data.status === 'waiting'),
      });
      // Flush any pending batched messages synchronously (outside
      // startTransition) so React commits them immediately.  Then
      // defer the result dispatch to the next animation frame — this
      // guarantees all prior startTransition updates (from
      // agent:tool_call, agent:status, etc.) have been committed
      // before the UI transitions to "completed".
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      const msgs = Array.from(pendingMessages.values());
      const toolOutputs = pendingToolOutputs.slice();
      pendingMessages.clear();
      pendingToolOutputs = [];

      // Flush pending messages/tool outputs synchronously
      if (msgs.length > 0 || toolOutputs.length > 0) {
        const store = useThreadStore.getState();
        for (const entry of msgs) store.handleWSMessage(entry.threadId, entry.data);
        for (const entry of toolOutputs) store.handleWSToolOutput(entry.threadId, entry.data);
      }

      // Defer result dispatch so prior transitions settle first
      requestAnimationFrame(() => {
        startTransition(() => {
          useThreadStore.getState().handleWSResult(threadId, data);
        });
      });

      // Final review pane refresh when agent finishes
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
      // Flush pending messages first so the parent message exists,
      // then dispatch tool_call — all inside one transition.
      const hasPendingTC = pendingMessages.size > 0;
      if (hasPendingTC && rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      startTransition(() => {
        if (hasPendingTC) {
          const msgs = Array.from(pendingMessages.values());
          pendingMessages.clear();
          // Note: only flushing messages here, not tool outputs
          const store = useThreadStore.getState();
          for (const entry of msgs) store.handleWSMessage(entry.threadId, entry.data);
        }
        useThreadStore.getState().handleWSToolCall(threadId, data);
      });
      // Signal ReviewPane when file-modifying tools are invoked
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
      const termStore = useTerminalStore.getState();
      if (data.status === 'exited' || data.status === 'stopped') {
        termStore.markCommandExited(data.commandId);
        closePreviewForCommand(data.commandId);
      }
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
      // New thread created externally (e.g. Chrome extension ingest)
      // Refresh threads for the project so it appears in the sidebar
      useThreadStore.getState().loadThreadsForProject(data.projectId);
      break;
    }
    case 'thread:comment_deleted': {
      // Comment deleted server-side — refresh the active thread if it matches
      const store = useThreadStore.getState();
      if (store.activeThread?.id === threadId) {
        store.refreshActiveThread();
      }
      break;
    }
    case 'thread:updated': {
      // Thread archived, status changed, or branch info updated server-side
      const store = useThreadStore.getState();
      if (data.status) {
        store.handleWSStatus(threadId, { status: data.status });
      }
      if (data.archived) {
        store.refreshAllLoadedThreads();
      }
      if (data.branch || data.worktreePath || data.containerUrl) {
        // Branch/worktree/container info arrived — refresh to pick it up
        if (store.activeThread?.id === threadId) {
          store.refreshActiveThread();
        }
      }
      break;
    }
    case 'git:status': {
      useGitStatusStore.getState().updateFromWS(data.statuses);
      // Bridge: also refresh ReviewPane diff when git status changes
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
          // Toast when pre-commit hooks fail
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
          setTimeout(() => store.finishCommit(threadId), 1500);
        } else if (wfStatus === 'failed') {
          store.replaceSteps(threadId, steps);
          toast.error('Workflow failed', {
            description: data.title || 'The git operation failed',
          });
          // Clean up after a delay so the user can see the failed state
          setTimeout(() => store.finishCommit(threadId), 5000);
        }
      });

      // Refresh review pane on completion or failure
      if (data.status === 'completed' || data.status === 'failed') {
        import('@/stores/review-pane-store').then(({ useReviewPaneStore }) => {
          useReviewPaneStore.getState().notifyDirty(threadId);
        });
      }
      break;
    }
    case 'thread:event': {
      startTransition(() => {
        const active = useThreadStore.getState().activeThread;
        if (active && active.id === threadId) {
          const existing = active.threadEvents ?? [];
          // Deduplicate by event ID to prevent double-rendering
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
      const termStore = useTerminalStore.getState();
      termStore.emitPtyData(data.ptyId, data.data);
      break;
    }
    case 'pty:exit': {
      const termStore = useTerminalStore.getState();
      termStore.markExited(data.ptyId);
      break;
    }
    case 'pty:error': {
      const termStore = useTerminalStore.getState();
      termStore.setTabError(data.ptyId, data.error ?? 'Failed to create terminal');
      toast.error(data.error ?? 'Failed to create terminal');
      break;
    }
    case 'pty:sessions': {
      if (data.sessions && data.sessions.length > 0) {
        // Projects may not be loaded yet (race with loadProjects).
        // Store pending sessions and attempt restoration; if projects are
        // empty, subscribe and retry once they arrive.
        import('@/stores/project-store').then(({ useProjectStore }) => {
          const tryRestore = () => {
            const projects = useProjectStore.getState().projects;
            const termStore = useTerminalStore.getState();
            // restoreTabs atomically updates tabs AND marks sessionsChecked
            // in a single set() call — avoids intermediate state flickers
            // that would cancel in-flight spawn retry timers for other tabs.
            termStore.restoreTabs(
              data.sessions,
              projects.map((p: any) => ({ id: p.id, path: p.path })),
            );
          };

          const projects = useProjectStore.getState().projects;
          if (projects.length > 0) {
            tryRestore();
          } else {
            // Projects not loaded yet — subscribe and restore when they arrive
            const unsub = useProjectStore.subscribe((state) => {
              if (state.projects.length > 0) {
                unsub();
                tryRestore();
              }
            });
            // Safety timeout: if projects never load within 10s, restore anyway
            setTimeout(() => {
              unsub();
              tryRestore();
            }, 10000);
          }
        });
      } else {
        // No sessions on server — mark checked so tabs can show their true state
        useTerminalStore.getState().markSessionsChecked();
      }
      break;
    }
    case 'thread:queue_update': {
      useThreadStore.getState().handleWSQueueUpdate(threadId, data);
      break;
    }
    case 'test:frame': {
      // Dispatch frame to canvas renderer via custom event (high-frequency, avoid store)
      import('@/components/test-runner/BrowserPreview').then(({ renderFrame }) => {
        renderFrame(data.data);
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
    case 'clone:progress': {
      window.dispatchEvent(new CustomEvent('clone:progress', { detail: data }));
      break;
    }
    case 'worktree:setup': {
      // Dispatch a custom DOM event for components listening for setup progress
      window.dispatchEvent(new CustomEvent('worktree:setup', { detail: { threadId, ...data } }));
      // Also update thread store for inline progress display
      useThreadStore.getState().handleWSWorktreeSetup(threadId, data);
      break;
    }
    case 'worktree:setup_complete': {
      useThreadStore.getState().handleWSWorktreeSetupComplete(threadId, data);
      break;
    }
  }
}

// ── Remote WS management ─────────────────────────────────────────

/** Open a WS connection to a remote container server (if not already open). */
export function connectRemoteWS(containerUrl: string) {
  if (stopped || remoteConnections.has(containerUrl)) return;

  const wsUrl = `${containerUrl.replace(/^http/, 'ws')}/ws`;
  wsLog.info('connecting remote WS', { containerUrl });

  const ws = new WebSocket(wsUrl);
  remoteConnections.set(containerUrl, ws);

  ws.onopen = () => {
    wsLog.info('remote WS connected', { containerUrl });
  };

  ws.onmessage = handleMessage;

  ws.onclose = () => {
    remoteConnections.delete(containerUrl);
    if (stopped) return;
    // Reconnect after delay if the connection was expected
    const timer = setTimeout(() => {
      remoteReconnectTimers.delete(containerUrl);
      // Only reconnect if a thread still needs this container
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

/** Close a remote container WS connection. */
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

/** Close all remote WS connections. */
function disconnectAllRemote() {
  for (const url of [...remoteConnections.keys()]) {
    disconnectRemoteWS(url);
  }
}

function connect() {
  if (stopped) return;

  const isTauri = !!(window as any).__TAURI_INTERNALS__;
  const serverPort = import.meta.env.VITE_SERVER_PORT || '3001';

  // Determine WebSocket base URL.
  // In the browser, use relative WS URL so it goes through the Vite proxy (same-origin).
  let base: string;
  if (isTauri) {
    base = `ws://localhost:${serverPort}/ws`;
  } else {
    base = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
  }

  // Cookies are sent automatically — no token needed
  const ws = new WebSocket(base);
  activeWS = ws;
  setupWS(ws);
}

function setupWS(ws: WebSocket) {
  ws.onopen = () => {
    // WebSocket connected — server is alive, so reset the HTTP circuit breaker
    // to dismiss the "server unavailable" overlay immediately
    useCircuitBreakerStore.getState().recordSuccess();
    // Always re-sync loaded threads on connect — events may have been lost
    // while disconnected (e.g. agent:result emitted when 0 clients were connected)
    useThreadStore.getState().refreshAllLoadedThreads();
    // Also re-sync git status for all loaded projects so diff stats stay in sync
    // with the refreshed thread data (avoids branchKey mismatches after reconnect).
    // Reset cooldowns first so the fetch isn't throttled after a disconnect.
    _resetCooldowns();
    const loadedProjectIds = Object.keys(useThreadStore.getState().threadsByProject);
    for (const pid of loadedProjectIds) {
      useGitStatusStore.getState().fetchForProject(pid);
    }
    _wasConnected = true;

    // Reset sessions-checked flag so persisted tabs don't show "(exited)" prematurely
    useTerminalStore.getState().resetSessionsChecked();

    // Ask server for any persistent PTY sessions (tmux) to restore.
    // The server may not respond immediately if the runner hasn't connected
    // yet — the runner will push sessions once it authenticates. Add a
    // safety timeout so tabs don't stay in loading state forever if the
    // runner never connects.
    try {
      ws.send(JSON.stringify({ type: 'pty:list', data: {} }));
    } catch {}
    const sessionsTimeout = setTimeout(() => {
      const termStore = useTerminalStore.getState();
      if (!termStore.sessionsChecked) {
        termStore.markSessionsChecked();
      }
    }, 30_000);
    // Clear the timeout if we disconnect before it fires
    ws.addEventListener('close', () => clearTimeout(sessionsTimeout), { once: true });
  };

  ws.onmessage = handleMessage;

  ws.onclose = (e) => {
    if (stopped) return;
    // If closed with 4001 (auth failed), trigger logout
    if (e.code === 4001 || e.code === 1008) {
      import('@/stores/auth-store').then(({ useAuthStore }) => {
        useAuthStore.getState().logout();
      });
      return;
    }
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function teardown() {
  stopped = true;
  disconnectAllRemote();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  pendingMessages.clear();
  pendingToolOutputs = [];
  if (activeWS) {
    // Null out handlers BEFORE closing to prevent the async close handshake
    // from triggering a phantom reconnection (StrictMode: teardown sets
    // stopped=true, but the remount resets stopped=false before the old WS
    // finishes closing — so its onclose would see stopped=false and reconnect).
    activeWS.onmessage = null;
    activeWS.onclose = null;
    activeWS.onerror = null;
    // If the socket is still CONNECTING, defer close until it opens to avoid
    // the browser warning "WebSocket is closed before the connection is
    // established". The nulled-out handlers prevent any event processing.
    if (activeWS.readyState === WebSocket.CONNECTING) {
      const pending = activeWS;
      pending.onopen = () => pending.close();
    } else {
      activeWS.close();
    }
    activeWS = null;
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

      // Disconnect from previous remote container
      if (lastContainerUrl) {
        disconnectRemoteWS(lastContainerUrl);
      }

      // Connect to new remote container
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

/** Get the active WebSocket instance (for sending messages from components) */
export function getActiveWS(): WebSocket | null {
  return activeWS;
}
