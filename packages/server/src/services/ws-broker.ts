import type { ServerWebSocket } from 'bun';
import type { WSEvent } from '@funny/shared';

class WSBroker {
  private clients = new Map<ServerWebSocket<unknown>, string>(); // ws → userId

  addClient(ws: ServerWebSocket<unknown>, userId: string): void {
    this.clients.set(ws, userId);
    console.log(`[ws] Client connected userId=${userId} (${this.clients.size} total)`);
  }

  removeClient(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws);
    console.log(`[ws] Client disconnected (${this.clients.size} total)`);
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
      console.warn(`[ws] agent:result for thread=${event.threadId} sent to 0 clients (userId=${userId}, total=${this.clients.size})`);
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
      console.warn(`[ws] agent:result for thread=${event.threadId} sent to 0 clients (broadcast, total=${this.clients.size})`);
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

export const wsBroker = new WSBroker();
