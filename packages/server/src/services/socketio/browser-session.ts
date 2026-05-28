import { BROWSER_SESSION_EVENTS } from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import { log } from '../../lib/logger.js';
import { rateLimitMiddleware } from './middleware.js';
import { registerSocketHandlers } from './router.js';
import { getIO } from './state.js';

/**
 * Forward browser-session commands from the browser socket to the user's runner.
 */
export function setupBrowserSessionHandlers(socket: Socket, userId: string): void {
  registerSocketHandlers(socket, {
    events: BROWSER_SESSION_EVENTS,
    middleware: [rateLimitMiddleware()],
    handler: async ({ eventName }, payload) => {
      const rm = await import('../runner-manager.js');
      const runnerId = await rm.findAnyRunnerForUser(userId);
      if (!runnerId) {
        log.warn('No runner for browser-session', {
          namespace: 'socketio',
          event: eventName,
          userId,
        });
        return;
      }

      const wsRelay = await import('../ws-relay.js');
      const socketId = wsRelay.getRunnerSocketId(runnerId);
      if (!socketId) return;

      getIO()
        .of('/runner')
        .to(socketId)
        .emit('central:browser_ws', {
          userId,
          data: { type: eventName, data: payload },
        });
    },
  });
}
