import { useEffect, startTransition } from 'react';

import { closePreviewForCommand } from '@/hooks/use-preview-window';
import { getAuthToken, getAuthMode } from '@/lib/api';
import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useThreadStore } from '@/stores/thread-store';

// Module-level singleton to prevent duplicate WebSocket connections
// (React StrictMode double-mounts effects in development)
let activeWS: WebSocket | null = null;
let refCount = 0;
let _wasConnected = false;
let stopped = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
      startTransition(() => {
        useThreadStore.getState().handleWSStatus(threadId, data);
      });
      break;
    case 'agent:result': {
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
      useThreadStore.getState().handleWSStatus(threadId, { status: 'failed' });
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
      if (data.branch || data.worktreePath) {
        // Branch/worktree info arrived from agent — refresh to pick it up
        if (store.activeThread?.id === threadId) {
          store.refreshActiveThread();
        }
      }
      break;
    }
    case 'git:status': {
      console.log('[ws] git:status received:', data.statuses);
      import('@/stores/git-status-store').then(({ useGitStatusStore }) => {
        useGitStatusStore.getState().updateFromWS(data.statuses);
      });
      break;
    }
    case 'thread:event': {
      import('@/stores/thread-store').then(({ useThreadStore }) => {
        startTransition(() => {
          const active = useThreadStore.getState().activeThread;
          if (active && active.id === threadId) {
            useThreadStore.setState({
              activeThread: {
                ...active,
                messages: active.messages,
                threadEvents: [...(active.threadEvents ?? []), data.event],
              },
            });
          }
        });
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
    case 'thread:queue_update': {
      useThreadStore.getState().handleWSQueueUpdate(threadId, data);
      break;
    }
  }
}

function connect() {
  if (stopped) return;

  const mode = getAuthMode();

  if (mode === 'local' || !mode) {
    // Local mode: require token
    const token = getAuthToken();
    if (!token) {
      // Token not yet available (initAuth still in progress), retry shortly
      reconnectTimer = setTimeout(connect, 500);
      return;
    }

    const isTauri = !!(window as any).__TAURI_INTERNALS__;
    const serverPort = import.meta.env.VITE_SERVER_PORT || '3001';
    const base = isTauri
      ? `ws://localhost:${serverPort}/ws`
      : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
    const url = `${base}?token=${encodeURIComponent(token)}`;
    console.log(`[ws] Connecting to ${base}...`);

    const ws = new WebSocket(url);
    activeWS = ws;
    setupWS(ws);
  } else {
    // Multi mode: no token needed, cookies are sent automatically
    const isTauri = !!(window as any).__TAURI_INTERNALS__;
    const serverPort = import.meta.env.VITE_SERVER_PORT || '3001';
    const base = isTauri
      ? `ws://localhost:${serverPort}/ws`
      : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
    console.log(`[ws] Connecting to ${base}...`);

    const ws = new WebSocket(base);
    activeWS = ws;
    setupWS(ws);
  }
}

function setupWS(ws: WebSocket) {
  ws.onopen = () => {
    console.log('[ws] Connected');
    // WebSocket connected — server is alive, so reset the HTTP circuit breaker
    // to dismiss the "server unavailable" overlay immediately
    useCircuitBreakerStore.getState().recordSuccess();
    // Always re-sync loaded threads on connect — events may have been lost
    // while disconnected (e.g. agent:result emitted when 0 clients were connected)
    console.log('[ws] Syncing all loaded threads with server');
    useThreadStore.getState().refreshAllLoadedThreads();
    _wasConnected = true;
  };

  ws.onmessage = handleMessage;

  ws.onclose = (e) => {
    if (stopped) return;
    // If closed with 4001 (auth failed), trigger logout in multi mode
    if (e.code === 4001 || e.code === 1008) {
      const mode = getAuthMode();
      if (mode === 'multi') {
        import('@/stores/auth-store').then(({ useAuthStore }) => {
          useAuthStore.getState().logout();
        });
        return;
      }
    }
    console.log('[ws] Disconnected, reconnecting in 2s...');
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function teardown() {
  stopped = true;
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
  activeWS?.close();
  activeWS = null;
  _wasConnected = false;
}

export function useWS() {
  useEffect(() => {
    refCount++;
    if (refCount === 1) {
      stopped = false;
      connect();
    }

    return () => {
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
