/**
 * Socket.IO server setup for browser communication.
 *
 * Uses @socket.io/bun-engine for native Bun WebSocket integration
 * instead of the default engine.io (which requires Node.js HTTP server events).
 *
 * Handler wiring lives under ./socketio/ — this file is bootstrap only.
 */

import { Server as BunEngine } from '@socket.io/bun-engine';
import { Server as SocketIOServer } from 'socket.io';

import { log } from '../lib/logger.js';
import { setBrowserEventSink } from './browser-events.js';
import { SocketIoBrowserEventSink } from './socketio/browser-event-sink.js';
import { isAllowedBrowserOrigin } from './socketio/origin.js';
import { bindSocketIOServer, closeSocketIOServer, getEngine, getIO } from './socketio/state.js';

export { isAllowedBrowserOrigin, getEngine, getIO };

/**
 * Create and configure the Socket.IO server with Bun engine.
 * Must be called after auth is initialized.
 */
/** The Socket.IO server, the Bun engine it is bound to, and its browser event sink. */
interface SocketIOHandles {
  io: SocketIOServer;
  engine: BunEngine;
  browserEvents: SocketIoBrowserEventSink;
}

export function createSocketIOServer(auth: any, corsOrigins: string[]): SocketIOHandles {
  const engine = new BunEngine({
    path: '/socket.io/',
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 32 * 1024 * 1024,
    cors: {
      origin: corsOrigins,
      credentials: true,
    },
  });

  const io = new SocketIOServer();
  io.bind(engine as any);

  bindSocketIOServer(io, engine, auth, corsOrigins);
  const browserEvents = new SocketIoBrowserEventSink(io);
  setBrowserEventSink(browserEvents);

  log.info('Socket.IO server created with Bun engine', { namespace: 'socketio' });

  return { io, engine, browserEvents };
}

export async function closeSocketIO(): Promise<void> {
  await closeSocketIOServer();
}
