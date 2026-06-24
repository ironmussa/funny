import { RUNNER_DATA_EVENTS, parseRunnerDataRequest } from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import { log } from '../../lib/logger.js';
import { isRateLimited } from '../socketio-rate-limit.js';

const DATA_RATE_LIMIT_WINDOW_MS = 10_000;
const FIRE_AND_FORGET_DATA_LIMIT = 1_000;
const REQUEST_RESPONSE_DATA_LIMIT = 5_000;

/**
 * Data persistence handlers for a runner socket (shared `data:response` channel).
 */
export function setupRunnerDataHandlers(
  socket: Socket,
  runnerId: string,
  runnerUserId: string | null,
): void {
  const inFlightRequestIds = new Set<string>();
  socket.on('disconnect', () => inFlightRequestIds.clear());

  const emitDataResponse = (requestId: string, response: unknown) => {
    socket.emit('data:response', { requestId, response });
  };

  for (const eventName of RUNNER_DATA_EVENTS) {
    socket.on(eventName, async (data: unknown, ack?: (response: unknown) => void) => {
      const msg = parseRunnerDataRequest(data);
      if (!msg) {
        log.warn('Invalid data event payload — dropping', {
          namespace: 'socketio',
          runnerId,
          type: eventName,
        });
        return;
      }
      const requestId = msg._requestId;
      const expectsResponse = !!requestId || typeof ack === 'function';
      const rateLimitKey = expectsResponse
        ? `${socket.id}:data:request-response`
        : `${socket.id}:data:fire-and-forget`;
      const rateLimit = expectsResponse ? REQUEST_RESPONSE_DATA_LIMIT : FIRE_AND_FORGET_DATA_LIMIT;

      if (isRateLimited(rateLimitKey, rateLimit, DATA_RATE_LIMIT_WINDOW_MS)) {
        log.warn('Data event rate-limited — dropping', {
          namespace: 'socketio',
          runnerId,
          type: eventName,
          requestId,
          expectsResponse,
        });
        const errorResponse = { error: 'Rate limit exceeded', success: false };
        if (requestId) {
          emitDataResponse(requestId, errorResponse);
        } else if (ack) {
          ack(errorResponse);
        }
        return;
      }

      if (requestId && inFlightRequestIds.has(requestId)) {
        log.warn('Duplicate in-flight requestId — dropping', {
          namespace: 'socketio',
          runnerId,
          type: eventName,
          requestId,
        });
        emitDataResponse(requestId, {
          error: 'Duplicate requestId in flight',
          success: false,
        });
        return;
      }
      if (requestId) inFlightRequestIds.add(requestId);

      try {
        const { handleDataMessageWithAck } = await import('../data-handler.js');
        const response = await handleDataMessageWithAck(runnerId, runnerUserId, {
          type: eventName,
          ...msg,
        });
        if (requestId && response !== undefined) {
          emitDataResponse(requestId, response);
        } else if (requestId) {
          emitDataResponse(requestId, { type: 'data:ack', success: true });
        }
        if (!requestId && ack && response !== undefined) {
          ack(response);
        }
      } catch (err) {
        log.error('Failed to handle data message', {
          namespace: 'socketio',
          runnerId,
          type: eventName,
          error: (err as Error).message,
        });
        const errorResponse = { error: (err as Error).message, success: false };
        if (requestId) {
          emitDataResponse(requestId, errorResponse);
        } else if (ack) {
          ack(errorResponse);
        }
      } finally {
        if (requestId) inFlightRequestIds.delete(requestId);
      }
    });
  }
}
