import { useEffect } from 'react';
import { useAppStore } from '@/stores/app-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { closePreviewForCommand } from '@/hooks/use-preview-window';
import { getAuthToken } from '@/lib/api';

// Module-level singleton to prevent duplicate WebSocket connections
// (React StrictMode double-mounts effects in development)
let activeWS: WebSocket | null = null;
let refCount = 0;
let wasConnected = false;
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

  const store = useAppStore.getState();

  // Flush messages (only the latest per thread — they're cumulative)
  for (const [, entry] of pendingMessages) {
    store.handleWSMessage(entry.threadId, entry.data);
  }
  pendingMessages.clear();

  // Flush tool outputs
  for (const entry of pendingToolOutputs) {
    store.handleWSToolOutput(entry.threadId, entry.data);
  }
  pendingToolOutputs = [];
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

    // Low-frequency events → immediate dispatch
    case 'agent:init':
      useAppStore.getState().handleWSInit(threadId, data);
      break;
    case 'agent:status':
      useAppStore.getState().handleWSStatus(threadId, data);
      break;
    case 'agent:result':
      // Flush any pending messages before result so ordering is preserved
      if (pendingMessages.size > 0 || pendingToolOutputs.length > 0) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        flushBatch();
      }
      useAppStore.getState().handleWSResult(threadId, data);
      // Final review pane refresh when agent finishes
      import('@/stores/review-pane-store').then(({ useReviewPaneStore }) => {
        useReviewPaneStore.getState().notifyDirty(threadId);
      });
      break;
    case 'agent:tool_call':
      // Flush pending messages first so the parent message exists
      if (pendingMessages.size > 0) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        flushBatch();
      }
      useAppStore.getState().handleWSToolCall(threadId, data);
      // Signal ReviewPane when file-modifying tools are invoked
      if (FILE_MODIFYING_TOOLS.has(data.name)) {
        import('@/stores/review-pane-store').then(({ useReviewPaneStore }) => {
          useReviewPaneStore.getState().notifyDirty(threadId);
        });
      }
      break;
    case 'agent:error':
      useAppStore.getState().handleWSStatus(threadId, { status: 'failed' });
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
    case 'git:status': {
      import('@/stores/git-status-store').then(({ useGitStatusStore }) => {
        useGitStatusStore.getState().updateFromWS(data.statuses);
      });
      break;
    }
  }
}

function connect() {
  if (stopped) return;

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

  ws.onopen = () => {
    console.log('[ws] Connected');
    if (wasConnected) {
      console.log('[ws] Reconnected — re-syncing all loaded threads');
      useAppStore.getState().refreshAllLoadedThreads();
    }
    wasConnected = true;
  };

  ws.onmessage = handleMessage;

  ws.onclose = () => {
    if (stopped) return;
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
  wasConnected = false;
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
