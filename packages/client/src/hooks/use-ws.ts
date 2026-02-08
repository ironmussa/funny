import { useEffect, useRef } from 'react';
import { useAppStore } from '@/stores/app-store';
import { useTerminalStore } from '@/stores/terminal-store';

export function useWS() {
  const wsRef = useRef<WebSocket | null>(null);
  const cleanedUp = useRef(false);

  useEffect(() => {
    cleanedUp.current = false;
    let wasConnected = false;

    function connect() {
      if (cleanedUp.current) return;

      const isTauri = !!(window as any).__TAURI_INTERNALS__;
      const url = isTauri
        ? 'ws://localhost:3001/ws'
        : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
      console.log(`[ws] Connecting to ${url}...`);

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[ws] Connected');
        // Re-sync active thread status after reconnection to catch
        // any status changes that were missed while disconnected
        if (wasConnected) {
          console.log('[ws] Reconnected — re-syncing active thread');
          useAppStore.getState().refreshActiveThread();
        }
        wasConnected = true;
      };

      ws.onmessage = (e) => {
        const event = JSON.parse(e.data);
        const { type, threadId, data } = event;
        const store = useAppStore.getState();

        switch (type) {
          case 'agent:init':
            store.handleWSInit(threadId, data);
            break;
          case 'agent:message':
            store.handleWSMessage(threadId, data);
            break;
          case 'agent:status':
            store.handleWSStatus(threadId, data);
            break;
          case 'agent:result':
            store.handleWSResult(threadId, data);
            break;
          case 'agent:tool_call':
            store.handleWSToolCall(threadId, data);
            break;
          case 'agent:tool_output':
            store.handleWSToolOutput(threadId, data);
            break;
          case 'agent:error':
            store.handleWSStatus(threadId, { status: 'failed' });
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
            }
            break;
          }
        }
      };

      ws.onclose = () => {
        if (cleanedUp.current) return;
        console.log('[ws] Disconnected, reconnecting in 2s...');
        setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      cleanedUp.current = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);
}
