import type { Server as SocketIOServer } from 'socket.io';

import type { BrowserEventSink } from '../runner-ports.js';

export const threadStreamRoom = (threadId: string): string => `thread:${threadId}:stream`;
export const threadPresenceRoom = (threadId: string): string => `thread:${threadId}:presence`;

/** Socket.IO adapter for browser-only publication and room membership. */
export class SocketIoBrowserEventSink implements BrowserEventSink {
  constructor(private readonly io: SocketIOServer) {}

  toUser(userId: string, event: Record<string, unknown>): void {
    this.io.of('/').to(`user:${userId}`).emit(this.eventType(event), event);
  }

  toAll(event: Record<string, unknown>): void {
    this.io.of('/').emit(this.eventType(event), event);
  }

  toThreadStream(threadId: string, event: Record<string, unknown>): void {
    this.io.of('/').to(threadStreamRoom(threadId)).emit(this.eventType(event), event);
  }

  toThreadPresence(threadId: string, event: Record<string, unknown>): void {
    this.io.of('/').to(threadPresenceRoom(threadId)).emit(this.eventType(event), event);
  }

  toThreadViewers(threadId: string, event: Record<string, unknown>): void {
    this.toThreadPresence(threadId, event);
  }

  evictFromThread(userId: string, threadId: string): void {
    this.io
      .of('/')
      .in(`user:${userId}`)
      .socketsLeave([threadStreamRoom(threadId), threadPresenceRoom(threadId)]);
  }

  connectedUserIds(): string[] {
    const userIds: string[] = [];
    for (const [room] of this.io.of('/').adapter.rooms) {
      if (room.startsWith('user:')) userIds.push(room.slice(5));
    }
    return userIds;
  }

  stats(): { browserClients: number; browserUsers: number } {
    return {
      browserClients: this.io.of('/').sockets.size,
      browserUsers: this.connectedUserIds().length,
    };
  }

  private eventType(event: Record<string, unknown>): string {
    return (event.type as string) || 'event';
  }
}
