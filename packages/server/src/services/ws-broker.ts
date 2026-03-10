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

class WSBroker {
  private clients = new Map<ServerWebSocket<unknown>, ClientInfo>();

  addClient(ws: ServerWebSocket<unknown>, userId: string, organizationId?: string | null): void {
    this.clients.set(ws, { userId, organizationId: organizationId ?? null });
    log.info('Client connected', {
      namespace: 'ws',
      userId,
      organizationId,
      total: this.clients.size,
    });
    metric('ws.connections', this.clients.size, { type: 'gauge' });
  }

  removeClient(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws);
    log.info('Client disconnected', { namespace: 'ws', total: this.clients.size });
    metric('ws.connections', this.clients.size, { type: 'gauge' });
  }

  /** Emit to all clients of a specific user */
  emitToUser(userId: string, event: WSEvent): void {
    const payload = JSON.stringify(event);
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
      log.warn('agent:result sent to 0 clients', {
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
    const payload = JSON.stringify(event);
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
      log.warn('agent:result sent to 0 clients (broadcast)', {
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
