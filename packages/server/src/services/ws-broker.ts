import type { WSEvent } from '@funny/shared';
import type { ServerWebSocket } from 'bun';

import { log } from '../lib/logger.js';

class WSBroker {
  private clients = new Map<ServerWebSocket<unknown>, string>(); // ws → userId

  addClient(ws: ServerWebSocket<unknown>, userId: string): void {
    this.clients.set(ws, userId);
    log.info('Client connected', { namespace: 'ws', userId, total: this.clients.size });
  }

  removeClient(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws);
    log.info('Client disconnected', { namespace: 'ws', total: this.clients.size });
  }

  /** Emit to all clients of a specific user */
  emitToUser(userId: string, event: WSEvent): void {
    const payload = JSON.stringify(event);
    const dead: ServerWebSocket<unknown>[] = [];
    let sent = 0;

    for (const [ws, uid] of this.clients) {
      if (uid !== userId) continue;
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

    if (sent === 0 && event.type === 'agent:result') {
      log.warn('agent:result sent to 0 clients', {
        namespace: 'ws',
        threadId: event.threadId,
        userId,
        total: this.clients.size,
      });
    }
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
