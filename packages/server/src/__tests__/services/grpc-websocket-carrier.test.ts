/**
 * websocket-carrier.ts — public WebSocket → private gRPC listener byte pipe.
 * Uses real Bun sockets: a TCP echo listener stands in for the gRPC listener.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  carrierTargetFor,
  createRunnerGrpcWebSocketCarrier,
  routeRunnerCarrier,
  withRunnerCarrier,
} from '../../services/grpc/websocket-carrier.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function startEchoListener() {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: (socket, chunk) => void socket.write(chunk) },
  });
  cleanups.push(() => listener.stop(true));
  return listener;
}

function startServer(carrier: ReturnType<typeof createRunnerGrpcWebSocketCarrier>) {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      if (new URL(req.url).pathname === carrier.path) return carrier.upgrade(req, srv as any);
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open: (ws: any) => carrier.websocket.open(ws),
      message: (ws: any, message: any) => carrier.websocket.message(ws, message),
      close: (ws: any) => carrier.websocket.close(ws),
    },
  });
  cleanups.push(() => server.stop(true));
  return server;
}

function openClient(port: number | undefined, path: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  ws.binaryType = 'arraybuffer';
  cleanups.push(() => ws.close());
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('websocket failed'));
  });
}

function nextMessage(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve) => {
    ws.onmessage = (event) => resolve(new Uint8Array(event.data as ArrayBuffer));
  });
}

function nextClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.onclose = (event) => resolve(event.code);
  });
}

describe('runner gRPC WebSocket carrier', () => {
  test('pipes binary frames to the listener and back', async () => {
    const echo = startEchoListener();
    const carrier = createRunnerGrpcWebSocketCarrier({
      target: { hostname: '127.0.0.1', port: echo.port },
    });
    const server = startServer(carrier);
    const ws = await openClient(server.port, carrier.path);

    const reply = nextMessage(ws);
    ws.send(new Uint8Array([0x50, 0x52, 0x49, 0x20]));
    expect([...(await reply)]).toEqual([0x50, 0x52, 0x49, 0x20]);
    expect(carrier.activeConnections()).toBe(1);
  });

  test('closes the WebSocket when the listener is unreachable', async () => {
    const echo = startEchoListener();
    const port = echo.port;
    echo.stop(true);
    const carrier = createRunnerGrpcWebSocketCarrier({ target: { hostname: '127.0.0.1', port } });
    const server = startServer(carrier);
    const ws = await openClient(server.port, carrier.path);
    expect(await nextClose(ws)).toBe(1011);
    expect(carrier.activeConnections()).toBe(0);
  });

  test('rejects text frames', async () => {
    const echo = startEchoListener();
    const carrier = createRunnerGrpcWebSocketCarrier({
      target: { hostname: '127.0.0.1', port: echo.port },
    });
    const server = startServer(carrier);
    const ws = await openClient(server.port, carrier.path);
    const closed = nextClose(ws);
    ws.send('hello');
    expect(await closed).toBe(1003);
  });

  test('refuses upgrades beyond capacity and non-upgrade requests', async () => {
    const echo = startEchoListener();
    const carrier = createRunnerGrpcWebSocketCarrier({
      target: { hostname: '127.0.0.1', port: echo.port },
      maxConnections: 1,
    });
    const server = startServer(carrier);
    await openClient(server.port, carrier.path);
    await Bun.sleep(20);
    await expect(openClient(server.port, carrier.path)).rejects.toThrow();
    const plain = await fetch(`http://127.0.0.1:${server.port}${carrier.path}`);
    expect(plain.status).toBe(426);
  });

  test('dials loopback for wildcard listener hosts', () => {
    expect(carrierTargetFor({ host: '[::]', port: 50051 })).toEqual({
      hostname: '127.0.0.1',
      port: 50051,
    });
    expect(carrierTargetFor({ host: '0.0.0.0', port: 1 }).hostname).toBe('127.0.0.1');
    expect(carrierTargetFor({ host: '10.0.0.5', port: 1 }).hostname).toBe('10.0.0.5');
  });

  test('routes WebSocket events to the carrier or Socket.IO by upgrade data', () => {
    const calls: string[] = [];
    const engine = {
      open: (_ws: any) => void calls.push('engine-open'),
      message: (_ws: any, _message: any) => void calls.push('engine-message'),
      close: (_ws: any, _code: number, _reason: string) => void calls.push('engine-close'),
    };
    const fakeCarrier = {
      websocket: {
        open: () => calls.push('carrier-open'),
        message: () => calls.push('carrier-message'),
        close: () => calls.push('carrier-close'),
      },
    } as any;
    const handlers = withRunnerCarrier(engine, fakeCarrier);
    handlers.open({ data: { kind: 'runner-grpc-ws' } });
    handlers.open({ data: { transport: {} } });
    handlers.close({ data: { kind: 'runner-grpc-ws' } }, 1000, '');
    expect(calls).toEqual(['carrier-open', 'engine-open', 'carrier-close']);
  });

  test('only claims the carrier path, and 404s it when the transport is disabled', () => {
    const other = new Request('http://x/api/projects');
    expect(routeRunnerCarrier(other, {}, null)).toBeNull();
    const carrierReq = new Request('http://x/api/runner-grpc/ws');
    expect(routeRunnerCarrier(carrierReq, {}, null)?.status).toBe(404);
  });
});
