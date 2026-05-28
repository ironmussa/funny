/**
 * Socket.IO server setup for runner and browser communication.
 *
 * Uses @socket.io/bun-engine for native Bun WebSocket integration
 * instead of the default engine.io (which requires Node.js HTTP server events).
 *
 * Handler wiring lives under ./socketio/ — this file is bootstrap only.
 */

import { Server as BunEngine } from '@socket.io/bun-engine';
import { Server as SocketIOServer } from 'socket.io';

import { log } from '../lib/logger.js';
import { setupBrowserNamespace } from './socketio/browser-namespace.js';
import { isAllowedBrowserOrigin } from './socketio/origin.js';
import { setupRunnerNamespace } from './socketio/runner-namespace.js';
import { bindSocketIOServer, closeSocketIOServer, getEngine, getIO } from './socketio/state.js';
import { setIO as setRelayIO } from './ws-relay.js';
import { setIO as setTunnelIO } from './ws-tunnel.js';

export { isAllowedBrowserOrigin, getEngine, getIO };

/**
 * Create and configure the Socket.IO server with Bun engine.
 * Must be called after auth is initialized.
 */
export function createSocketIOServer(
  auth: any,
  corsOrigins: string[],
): { io: SocketIOServer; engine: BunEngine } {
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
  setRelayIO(io);
  setTunnelIO(io);

  setupBrowserNamespace();
  setupRunnerNamespace();

  log.info('Socket.IO server created with Bun engine', { namespace: 'socketio' });

  return { io, engine };
}

export async function closeSocketIO(): Promise<void> {
  await closeSocketIOServer();
}
