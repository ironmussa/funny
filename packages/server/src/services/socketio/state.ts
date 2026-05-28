import type { Server as BunEngine } from '@socket.io/bun-engine';
import type { Server as SocketIOServer } from 'socket.io';

let io: SocketIOServer | null = null;
let engine: BunEngine | null = null;

export let authInstance: any = null;
export let allowedOrigins: string[] = [];

export function bindSocketIOServer(
  nextIo: SocketIOServer,
  nextEngine: BunEngine,
  auth: any,
  corsOrigins: string[],
): void {
  io = nextIo;
  engine = nextEngine;
  authInstance = auth;
  allowedOrigins = corsOrigins;
}

export function clearSocketIOServer(): void {
  io = null;
  engine = null;
  authInstance = null;
  allowedOrigins = [];
}

export function getEngine(): BunEngine {
  if (!engine) throw new Error('Socket.IO engine not initialized');
  return engine;
}

export function getIO(): SocketIOServer {
  if (!io) throw new Error('Socket.IO server not initialized');
  return io;
}

export async function closeSocketIOServer(): Promise<void> {
  if (io) {
    io.close();
  }
  clearSocketIOServer();
}
