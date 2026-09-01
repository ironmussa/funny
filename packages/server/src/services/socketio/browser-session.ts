import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import { BROWSER_SESSION_EVENTS, socketObjectPayloadSchema } from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import { log } from '../../lib/logger.js';
import type { RunnerRequestPort } from '../runner-ports.js';
import { rateLimitMiddleware } from './middleware.js';
import { registerSocketHandlersWithSchema } from './router.js';

export function signedRunnerHeaders(userId: string): Record<string, string> {
  const secret = process.env.RUNNER_AUTH_SECRET;
  if (!secret) throw new Error('RUNNER_AUTH_SECRET is not set');
  const { signature, timestamp, nonce } = signForwardedIdentity(
    { userId, role: 'user', orgId: null, orgName: null, shareLevel: null, onBehalfOfThread: null },
    secret,
  );
  return {
    'content-type': 'application/json',
    'X-Runner-Auth': secret,
    'X-Forwarded-User': userId,
    'X-Forwarded-Role': 'user',
    [SIGNATURE_HEADER]: signature,
    [TIMESTAMP_HEADER]: String(timestamp),
    [NONCE_HEADER]: nonce,
  };
}

/**
 * Forward browser-session commands from the browser socket to the user's runner.
 */
export function setupBrowserSessionHandlers(
  socket: Socket,
  userId: string,
  dependencies: {
    requests?: RunnerRequestPort;
    findAnyRunnerForUser(userId: string): Promise<string | null>;
  },
): void {
  registerSocketHandlersWithSchema(socket, {
    events: BROWSER_SESSION_EVENTS,
    payloadSchema: socketObjectPayloadSchema,
    middleware: [rateLimitMiddleware()],
    handler: async ({ eventName }, payload) => {
      const runnerId = await dependencies.findAnyRunnerForUser(userId);
      if (!runnerId || !dependencies.requests?.isAvailable(runnerId)) {
        log.warn('No runner for browser-session', {
          namespace: 'socketio',
          event: eventName,
          userId,
        });
        return;
      }

      try {
        await dependencies.requests.request(runnerId, {
          method: 'POST',
          path: '/api/browser-session/command',
          headers: signedRunnerHeaders(userId),
          body: JSON.stringify({ type: eventName, data: payload }),
        });
      } catch (error) {
        log.warn('Browser-session gRPC dispatch failed', {
          namespace: 'socketio',
          event: eventName,
          userId,
          runnerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}
