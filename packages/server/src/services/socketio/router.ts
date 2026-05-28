import { parseObjectPayload } from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

export interface SocketHandlerContext {
  socket: Socket;
  eventName: string;
}

/** Return false to drop the event (after optional side effects in the middleware). */
export type SocketEventMiddleware = (
  ctx: SocketHandlerContext,
  data: unknown,
) => boolean | Promise<boolean>;

export function registerSocketHandlers(
  socket: Socket,
  spec: {
    events: readonly string[];
    middleware?: SocketEventMiddleware[];
    handler: (ctx: SocketHandlerContext, payload: Record<string, unknown>) => void | Promise<void>;
  },
): void {
  const middleware = spec.middleware ?? [];
  for (const eventName of spec.events) {
    socket.on(eventName, async (data: unknown) => {
      const ctx: SocketHandlerContext = { socket, eventName };
      for (const mw of middleware) {
        if (!(await mw(ctx, data))) return;
      }
      const payload = parseObjectPayload(data);
      if (payload === null) return;
      await spec.handler(ctx, payload);
    });
  }
}

export function registerSocketRpc<TResponse>(
  socket: Socket,
  eventName: string,
  spec: {
    middleware?: SocketEventMiddleware[];
    handler: (
      ctx: SocketHandlerContext,
      ack: (response: TResponse) => void,
      data: unknown,
    ) => void | Promise<void>;
  },
): void {
  socket.on(eventName, async (data: unknown, ack?: (response: TResponse) => void) => {
    if (typeof ack !== 'function') return;
    const ctx: SocketHandlerContext = { socket, eventName };
    for (const mw of spec.middleware ?? []) {
      if (!(await mw(ctx, data))) return;
    }
    await spec.handler(ctx, ack, data);
  });
}
