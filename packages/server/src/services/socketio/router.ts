import {
  parseSocketPayload,
  socketObjectPayloadSchema,
  type SocketObjectPayload,
} from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';
import type { z, ZodTypeAny } from 'zod';

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
    handler: (ctx: SocketHandlerContext, payload: SocketObjectPayload) => void | Promise<void>;
  },
): void {
  registerSocketHandlersWithSchema(socket, {
    ...spec,
    payloadSchema: socketObjectPayloadSchema,
  });
}

export function registerSocketHandlersWithSchema<TSchema extends ZodTypeAny>(
  socket: Socket,
  spec: {
    events: readonly string[];
    payloadSchema: TSchema;
    middleware?: SocketEventMiddleware[];
    handler: (ctx: SocketHandlerContext, payload: z.infer<TSchema>) => void | Promise<void>;
  },
): void {
  const middleware = spec.middleware ?? [];
  for (const eventName of spec.events) {
    socket.on(eventName, async (data: unknown) => {
      const ctx: SocketHandlerContext = { socket, eventName };
      for (const mw of middleware) {
        if (!(await mw(ctx, data))) return;
      }
      const payload = parseSocketPayload(spec.payloadSchema, data);
      if (payload === null) return;
      await spec.handler(ctx, payload);
    });
  }
}

export function registerSocketRpc<
  TResponse,
  TSchema extends ZodTypeAny = typeof socketObjectPayloadSchema,
>(
  socket: Socket,
  eventName: string,
  spec: {
    payloadSchema?: TSchema;
    invalidPayloadResponse?: TResponse;
    middleware?: SocketEventMiddleware[];
    handler: (
      ctx: SocketHandlerContext,
      ack: (response: TResponse) => void,
      data: z.infer<TSchema>,
    ) => void | Promise<void>;
  },
): void {
  socket.on(eventName, async (data: unknown, ack?: (response: TResponse) => void) => {
    if (typeof ack !== 'function') return;
    const ctx: SocketHandlerContext = { socket, eventName };
    for (const mw of spec.middleware ?? []) {
      if (!(await mw(ctx, data))) return;
    }
    const schema = (spec.payloadSchema ?? socketObjectPayloadSchema) as TSchema;
    const payload = parseSocketPayload(schema, data);
    if (payload === null) {
      if (spec.invalidPayloadResponse !== undefined) ack(spec.invalidPayloadResponse);
      return;
    }
    await spec.handler(ctx, ack, payload);
  });
}
