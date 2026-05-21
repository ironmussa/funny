/**
 * @domain subdomain: Real-time Communication
 * @domain subdomain-type: supporting
 * @domain type: event-bus
 * @domain layer: infrastructure
 * @domain consumes: agent:error, agent:message, agent:tool_call, agent:tool_output, agent:result, agent:status, git:status, command:status, command:output, thread:created, thread:deleted, thread:stage-changed
 */

import type { WSEvent } from '@funny/shared';
import type { ServerWebSocket } from 'bun';

import { log } from '../lib/logger.js';
import { metric } from '../lib/telemetry.js';

interface ClientInfo {
  userId: string;
  organizationId: string | null;
}

export type WSEventListener = (event: WSEvent, userId?: string) => void;

/** Maximum payload size in bytes before logging a warning (1 MB) */
const MAX_PAYLOAD_WARN_BYTES = 1_048_576;
/** Maximum payload size in bytes — payloads above this are dropped (10 MB) */
const MAX_PAYLOAD_DROP_BYTES = 10_485_760;
/** Ping interval in milliseconds (30 seconds) */
const PING_INTERVAL_MS = 30_000;
/** Number of missed pongs before considering a client dead */
const MAX_MISSED_PONGS = 2;

class WSBroker {
  private clients = new Map<ServerWebSocket<unknown>, ClientInfo>();
  private listeners: WSEventListener[] = [];
  private missedPongs = new Map<ServerWebSocket<unknown>, number>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Register a listener that is called on every emitted event (used by team-client for forwarding) */
  onEvent(listener: WSEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notifyListeners(event: WSEvent, userId?: string): void {
    for (const listener of this.listeners) {
      try {
        listener(event, userId);
      } catch {}
    }
  }

  /** Start the periodic ping interval to detect dead connections */
  startPing(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      const dead: ServerWebSocket<unknown>[] = [];
      for (const [ws] of this.clients) {
        const missed = this.missedPongs.get(ws) ?? 0;
        if (missed >= MAX_MISSED_PONGS) {
          dead.push(ws);
          continue;
        }
        try {
          ws.ping();
          this.missedPongs.set(ws, missed + 1);
        } catch {
          dead.push(ws);
        }
      }
      for (const ws of dead) {
        log.info('Removing dead client (missed pongs)', { namespace: 'ws' });
        this.clients.delete(ws);
        this.missedPongs.delete(ws);
      }
      if (dead.length > 0) {
        metric('ws.connections', this.clients.size, { type: 'gauge' });
      }
    }, PING_INTERVAL_MS);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  /** Stop the ping interval */
  stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Record a pong received from a client */
  handlePong(ws: ServerWebSocket<unknown>): void {
    // Only track pongs for known clients — avoids leaking missedPongs entries
    // for ws instances that were never registered via addClient.
    if (this.clients.has(ws)) {
      this.missedPongs.set(ws, 0);
    }
  }

  addClient(ws: ServerWebSocket<unknown>, userId: string, organizationId?: string | null): void {
    // Defensive: if the same ws is re-registered (reconnect race), drop the
    // prior entry so missedPongs / clients cannot diverge.
    if (this.clients.has(ws)) {
      this.clients.delete(ws);
      this.missedPongs.delete(ws);
    }
    this.clients.set(ws, { userId, organizationId: organizationId ?? null });
    this.missedPongs.set(ws, 0);
    log.info('Client connected', {
      namespace: 'ws',
      userId,
      organizationId,
      total: this.clients.size,
    });
    metric('ws.connections', this.clients.size, { type: 'gauge' });
    // Start ping when first client connects
    if (this.clients.size === 1) this.startPing();
  }

  removeClient(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws);
    this.missedPongs.delete(ws);
    log.info('Client disconnected', { namespace: 'ws', total: this.clients.size });
    metric('ws.connections', this.clients.size, { type: 'gauge' });
    // Stop ping when no clients remain
    if (this.clients.size === 0) this.stopPing();
  }

  /** Check payload size and return null if it should be dropped */
  private checkPayloadSize(payload: string, event: WSEvent): boolean {
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > MAX_PAYLOAD_DROP_BYTES) {
      log.warn('Dropping oversized WS payload', {
        namespace: 'ws',
        event: event.type,
        threadId: (event as any).threadId,
        bytes,
        maxBytes: MAX_PAYLOAD_DROP_BYTES,
      });
      metric('ws.payload_dropped', 1, { type: 'sum', attributes: { event: event.type } });
      return false;
    }
    if (bytes > MAX_PAYLOAD_WARN_BYTES) {
      log.warn('Large WS payload', {
        namespace: 'ws',
        event: event.type,
        threadId: (event as any).threadId,
        bytes,
      });
      metric('ws.payload_large', 1, { type: 'sum', attributes: { event: event.type } });
    }
    return true;
  }

  /** Emit to all clients of a specific user */
  emitToUser(userId: string, event: WSEvent): void {
    this.notifyListeners(event, userId);

    // In production runner mode the only consumer is the listener above
    // (forwardEventToCentral → Socket.IO). Skip JSON.stringify entirely
    // when no native clients are attached — saves CPU on the hot PTY path
    // and avoids Buffer.toJSON() expanding binary pty:data payloads into
    // {type:'Buffer',data:[…]} arrays for the size guard.
    if (this.clients.size === 0) {
      metric('ws.events', 1, { type: 'sum', attributes: { event: event.type, sent: '0' } });
      return;
    }

    const payload = JSON.stringify(event);
    if (!this.checkPayloadSize(payload, event)) return;
    const dead: ServerWebSocket<unknown>[] = [];
    let sent = 0;

    for (const [ws, info] of this.clients) {
      if (info.userId !== userId) continue;
      try {
        ws.send(payload);
        sent++;
      } catch {
        dead.push(ws);
      }
    }

    for (const ws of dead) {
      this.clients.delete(ws);
    }

    metric('ws.events', 1, { type: 'sum', attributes: { event: event.type, sent: String(sent) } });

    if (sent === 0 && event.type === 'agent:result') {
      log.debug('agent:result sent to 0 clients', {
        namespace: 'ws',
        threadId: event.threadId,
        userId,
        total: this.clients.size,
      });
    }
  }

  /** Emit to all clients in a specific organization */
  emitToOrg(orgId: string, event: WSEvent): void {
    const payload = JSON.stringify(event);
    if (!this.checkPayloadSize(payload, event)) return;
    const dead: ServerWebSocket<unknown>[] = [];
    let sent = 0;

    for (const [ws, info] of this.clients) {
      if (info.organizationId !== orgId) continue;
      try {
        ws.send(payload);
        sent++;
      } catch {
        dead.push(ws);
      }
    }

    for (const ws of dead) {
      this.clients.delete(ws);
    }

    metric('ws.events', 1, {
      type: 'sum',
      attributes: { event: event.type, sent: String(sent), orgId },
    });
  }

  /** Emit to all connected clients (broadcast) */
  emit(event: WSEvent): void {
    this.notifyListeners(event);

    const payload = JSON.stringify(event);
    if (!this.checkPayloadSize(payload, event)) return;
    const dead: ServerWebSocket<unknown>[] = [];
    let sent = 0;

    for (const [ws] of this.clients) {
      try {
        ws.send(payload);
        sent++;
      } catch {
        dead.push(ws);
      }
    }

    for (const ws of dead) {
      this.clients.delete(ws);
    }

    metric('ws.events', 1, { type: 'sum', attributes: { event: event.type, sent: String(sent) } });

    if (sent === 0 && event.type === 'agent:result') {
      log.debug('agent:result sent to 0 clients (broadcast)', {
        namespace: 'ws',
        threadId: event.threadId,
        total: this.clients.size,
      });
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

export const wsBroker = new WSBroker();
