import type { Socket } from 'socket.io';

import { log } from '../../lib/logger.js';
import { clearSocketRate } from '../socketio-rate-limit.js';
import { setupBrowserPtyListRpc } from './browser-pty-list.js';
import { setupBrowserPtyHandlers } from './browser-pty.js';
import { setupBrowserSessionHandlers } from './browser-session.js';
import { isAllowedBrowserOrigin } from './origin.js';
import { allowedOrigins, authInstance, getIO } from './state.js';
import { setupThreadPresenceHandlers } from './thread-presence.js';

export function setupBrowserNamespace(): void {
  const io = getIO();
  const browserNsp = io.of('/');

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

    import('../ws-relay.js').then((wsRelay) => {
      socket.emit('runner:status', {
        status: wsRelay.userHasConnectedRunner(userId) ? 'online' : 'offline',
      });
    });

    setupBrowserPtyHandlers(socket, userId);
    setupBrowserPtyListRpc(socket, userId);
    setupBrowserSessionHandlers(socket, userId);
    setupThreadPresenceHandlers(socket, userId);

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
