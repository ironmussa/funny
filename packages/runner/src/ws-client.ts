/**
 * WebSocket client for streaming agent events to the central server.
 * Only used for real-time agent message streaming — all other communication uses HTTP.
 */

import type { WSEvent } from '@funny/shared';
import type { RunnerWSMessage, CentralWSMessage, RunnerTask } from '@funny/shared/runner-protocol';

export interface WSClientOptions {
  serverUrl: string;
  runnerId: string;
  token: string;
  onCommand?: (task: RunnerTask) => void;
}

export class RunnerWSClient {
  private ws: WebSocket | null = null;
  private opts: WSClientOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;

  constructor(opts: WSClientOptions) {
    this.opts = opts;
  }

  connect(): void {
    if (this.ws) return;

    const wsUrl = this.opts.serverUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/runner';

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.info('[runner-ws] Connected to central server');
      this.connected = true;

      // Authenticate
      const authMsg: RunnerWSMessage = {
        type: 'runner:auth',
        runnerId: this.opts.runnerId,
        token: this.opts.token,
      };
      this.ws!.send(JSON.stringify(authMsg));

      // Start ping interval (30s)
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          const ping: RunnerWSMessage = { type: 'runner:ping' };
          this.ws.send(JSON.stringify(ping));
        }
      }, 30_000);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as CentralWSMessage;
        this.handleMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      console.info('[runner-ws] Disconnected from central server');
      this.cleanup();
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[runner-ws] WebSocket error:', err);
    };
  }

  private handleMessage(msg: CentralWSMessage): void {
    switch (msg.type) {
      case 'central:auth_ok':
        console.info('[runner-ws] Authenticated with central server');
        break;
      case 'central:pong':
        // Heartbeat acknowledged
        break;
      case 'central:command':
        this.opts.onCommand?.(msg.task);
        break;
    }
  }

  /**
   * Send an agent event to the central server for relay to browser clients.
   */
  sendAgentEvent(threadId: string, event: WSEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg: RunnerWSMessage = {
      type: 'runner:agent_event',
      threadId,
      event,
    };
    this.ws.send(JSON.stringify(msg));
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanup();
    this.ws?.close();
    this.ws = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private cleanup(): void {
    this.connected = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ws = null;
      console.info('[runner-ws] Attempting reconnect...');
      this.connect();
    }, 5_000);
  }
}
