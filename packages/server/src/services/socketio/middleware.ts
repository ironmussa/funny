import type { Socket } from 'socket.io';

import { isRateLimited } from '../socketio-rate-limit.js';
import type { SocketEventMiddleware } from './router.js';

export function rateLimitMiddleware(maxEvents = 100, windowMs = 1_000): SocketEventMiddleware {
  return (ctx) => !isRateLimited(ctx.socket.id, maxEvents, windowMs);
}
