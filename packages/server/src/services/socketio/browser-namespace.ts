import type { Socket } from 'socket.io';

import { log } from '../../lib/logger.js';
import type { RunnerPresencePort, RunnerRequestPort, RunnerTerminalPort } from '../runner-ports.js';
import { clearSocketRate } from '../socketio-rate-limit.js';
import { setupBrowserPtyListRpc } from './browser-pty-list.js';
import { setupBrowserPtyHandlers } from './browser-pty.js';
import type { BrowserPtyDependencies } from './browser-pty.js';
import { setupBrowserSessionHandlers } from './browser-session.js';
import { setupBrowserV1Events } from './browser-v1-events.js';
import { setupBrowserV1Interactive } from './browser-v1-interactive.js';
import { setupBrowserV1Negotiation } from './browser-v1-negotiation.js';
import { setupBrowserV1Operations } from './browser-v1-operations.js';
import {
  BrowserV1RolloutPolicy,
  browserV1RolloutPolicyFromEnvironment,
} from './browser-v1-rollout.js';
import { setupBrowserV1SessionGuard } from './browser-v1-session-guard.js';
import { isAllowedBrowserOrigin } from './origin.js';
import { allowedOrigins, authInstance, getIO } from './state.js';
import { setupThreadPresenceHandlers } from './thread-presence.js';

export interface BrowserNamespaceDependencies extends Omit<BrowserPtyDependencies, 'terminals'> {
  presence?: RunnerPresencePort;
  requests?: RunnerRequestPort;
  terminals?: RunnerTerminalPort;
  browserV1Rollout?: BrowserV1RolloutPolicy;
}

export function setupBrowserNamespace(dependencies: BrowserNamespaceDependencies): void {
  const io = getIO();
  const browserNsp = io.of('/');
  const browserV1Rollout = dependencies.browserV1Rollout ?? browserV1RolloutPolicyFromEnvironment();

  browserNsp.use(async (socket, next) => {
    try {
      const origin = socket.handshake.headers.origin as string | undefined;
      if (!isAllowedBrowserOrigin(origin, allowedOrigins)) {
        log.warn('Socket.IO browser namespace rejected upgrade: Origin not in allowlist', {
          namespace: 'socketio',
          origin: origin ?? null,
        });
        return next(new Error('Origin not allowed'));
      }

      const cookieHeader = socket.handshake.headers.cookie;
      if (!cookieHeader) {
        return next(new Error('No session cookie'));
      }

      const headers = new Headers();
      headers.set('cookie', cookieHeader);
      const session = await authInstance.api.getSession({ headers });

      if (!session) {
        return next(new Error('Invalid session'));
      }

      socket.data = {
        userId: session.user.id,
        type: 'browser',
      };
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  browserNsp.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string;

    socket.join(`user:${userId}`);

    log.info('Browser client connected via Socket.IO', {
      namespace: 'socketio',
      userId,
      socketId: socket.id,
      transport: socket.conn.transport.name,
    });

    socket.emit('runner:status', {
      status: dependencies.presence?.userHasAvailableRunner(userId) ? 'online' : 'offline',
    });

    setupBrowserPtyHandlers(socket, userId, dependencies);
    setupBrowserPtyListRpc(socket, userId, dependencies);
    setupBrowserSessionHandlers(socket, userId, dependencies);
    setupThreadPresenceHandlers(socket, userId);
    setupBrowserV1Negotiation(socket, userId, browserV1Rollout);
    setupBrowserV1Operations(socket, userId, dependencies);
    setupBrowserV1Events(socket, userId);
    setupBrowserV1Interactive(socket, userId, dependencies);
    setupBrowserV1SessionGuard(socket, userId, {
      getSession: (headers) => authInstance.api.getSession({ headers }),
    });

    socket.on('disconnect', (reason) => {
      clearSocketRate(socket.id);
      log.info('Browser client disconnected', {
        namespace: 'socketio',
        userId,
        reason,
      });
    });
  });
}
