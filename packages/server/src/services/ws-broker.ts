import type { ServerWebSocket } from 'bun';
import type { WSEvent } from '@a-parallel/shared';

class WSBroker {
  private clients = new Set<ServerWebSocket<unknown>>();

  addClient(ws: ServerWebSocket<unknown>): void {
    this.clients.add(ws);
    console.log(`[ws] Client connected (${this.clients.size} total)`);
  }

  removeClient(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws);
    console.log(`[ws] Client disconnected (${this.clients.size} total)`);
  }

  emit(event: WSEvent): void {
    const payload = JSON.stringify(event);
    const dead: ServerWebSocket<unknown>[] = [];

    for (const ws of this.clients) {
      try {
        ws.send(payload);
      } catch {
        dead.push(ws);
      }
    }

    for (const ws of dead) {
      this.clients.delete(ws);
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

export const wsBroker = new WSBroker();
