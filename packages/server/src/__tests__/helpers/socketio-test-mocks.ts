import type { Socket } from 'socket.io';

type Handler = (...args: unknown[]) => unknown | Promise<unknown>;

export interface MockSocket extends Socket {
  readonly handlers: Map<string, Handler[]>;
  readonly emitted: Array<{ event: string; data: unknown }>;
  trigger(event: string, ...args: unknown[]): Promise<void>;
  triggerRpc<T>(event: string, data: unknown, ack: (response: T) => void): Promise<void>;
  clearEmitted(): void;
}

export function createMockSocket(overrides: Partial<MockSocket> = {}): MockSocket {
  const handlers = new Map<string, Handler[]>();
  const emitted: Array<{ event: string; data: unknown }> = [];

  const socket = {
    id: 'mock-socket-id',
    data: {},
    handlers,
    emitted,
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event: string, data: unknown) {
      emitted.push({ event, data });
    },
    async trigger(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(...args);
      }
    },
    async triggerRpc<T>(event: string, data: unknown, ack: (response: T) => void) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(data, ack);
      }
    },
    clearEmitted() {
      emitted.length = 0;
    },
  };

  return Object.assign(socket, overrides) as MockSocket;
}

export interface MockIoCapture {
  readonly centralBrowserWs: Array<{ socketId: string; payload: unknown }>;
  readonly userRoomEmits: Array<{ room: string; event: string; payload: unknown }>;
}

export function createMockIo(options?: {
  runnerSocket?: {
    timeout: (ms: number) => { emitWithAck: (...args: unknown[]) => Promise<unknown> };
  } | null;
}): { io: any; capture: MockIoCapture } {
  const centralBrowserWs: MockIoCapture['centralBrowserWs'] = [];
  const userRoomEmits: MockIoCapture['userRoomEmits'] = [];

  const io = {
    of(nsp: string) {
      if (nsp === '/runner') {
        return {
          to(socketId: string) {
            return {
              emit(event: string, payload: unknown) {
                if (event === 'central:browser_ws') {
                  centralBrowserWs.push({ socketId, payload });
                }
              },
            };
          },
          sockets: {
            get(_id: string) {
              return options?.runnerSocket ?? null;
            },
          },
        };
      }
      return {
        to(room: string) {
          return {
            emit(event: string, payload: unknown) {
              userRoomEmits.push({ room, event, payload });
            },
          };
        },
      };
    },
  };

  return { io, capture: { centralBrowserWs, userRoomEmits } };
}

export interface RunnerNamespaceTestHarness {
  io: ReturnType<typeof createMockIo>['io'] & { close: () => void };
  authMiddlewares: Array<(socket: any, next: (err?: Error) => void) => void | Promise<void>>;
  connectionHandlers: Array<(socket: any) => void | Promise<void>>;
  userRoomEmits: Array<{ room: string; event: string; payload: unknown }>;
  runnerSockets: Map<string, { disconnect: any }>;
}

/** IO stub with separate /runner and / browser namespace wiring. */
export function createRunnerNamespaceTestIo(): RunnerNamespaceTestHarness {
  const authMiddlewares: RunnerNamespaceTestHarness['authMiddlewares'] = [];
  const connectionHandlers: RunnerNamespaceTestHarness['connectionHandlers'] = [];
  const userRoomEmits: RunnerNamespaceTestHarness['userRoomEmits'] = [];
  const runnerSockets = new Map<string, { disconnect: any }>();

  const io = {
    close: () => {},
    of(nsp: string) {
      if (nsp === '/runner') {
        return {
          use(fn: RunnerNamespaceTestHarness['authMiddlewares'][number]) {
            authMiddlewares.push(fn);
          },
          on(event: string, fn: RunnerNamespaceTestHarness['connectionHandlers'][number]) {
            if (event === 'connection') connectionHandlers.push(fn);
          },
          sockets: {
            get(id: string) {
              return runnerSockets.get(id);
            },
          },
        };
      }
      return {
        to(room: string) {
          return {
            emit(event: string, payload: unknown) {
              userRoomEmits.push({ room, event, payload });
            },
          };
        },
      };
    },
  };

  return { io, authMiddlewares, connectionHandlers, userRoomEmits, runnerSockets };
}
