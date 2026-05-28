import { RUNNER_DATA_EVENTS } from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import { log } from '../../lib/logger.js';
import { isRateLimited } from '../socketio-rate-limit.js';

const REQUEST_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

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
      const msg = (data ?? {}) as Record<string, unknown> & { _requestId?: string };
      const requestId = msg._requestId;

      if (isRateLimited(socket.id, 1_000, 10_000)) {
        log.warn('Data event rate-limited — dropping', {
          namespace: 'socketio',
          runnerId,
          type: eventName,
          requestId,
        });
        const errorResponse = { error: 'Rate limit exceeded', success: false };
        if (requestId && typeof requestId === 'string' && REQUEST_ID_RE.test(requestId)) {
          emitDataResponse(requestId, errorResponse);
        } else if (ack) {
          ack(errorResponse);
        }
        return;
      }

      if (requestId && (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId))) {
        log.warn('Invalid requestId format', { namespace: 'socketio', runnerId, type: eventName });
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
