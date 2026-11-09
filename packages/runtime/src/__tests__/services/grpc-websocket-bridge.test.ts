import { RUNNER_GRPC_WS_PATH } from '@funny/shared/runner-protocol';
/**
 * grpc-websocket-bridge.ts — loopback TCP → WebSocket carrier, plus endpoint
 * derivation. A Bun WebSocket echo server stands in for the funny server.
 */
import { afterEach, describe, expect, test } from 'vitest';

import {
  isWebSocketEndpoint,
  startGrpcWebSocketBridge,
} from '../../services/grpc-websocket-bridge.js';
import { requireRunnerGrpcEndpoint } from '../../services/runner-connection-supervisor.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function startEchoWebSocketServer() {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no', { status: 400 })),
    websocket: { message: (ws, message) => void ws.send(message) },
  });
  cleanups.push(() => server.stop(true));
  return server;
}

function connectTcp(address: string, onData: (chunk: Uint8Array) => void) {
  const [hostname, port] = address.split(':');
  return Bun.connect({
    hostname,
    port: Number(port),
    socket: { data: (_socket, chunk) => onData(new Uint8Array(chunk)) },
  });
}

describe('runner gRPC WebSocket bridge', () => {
  test('pipes loopback TCP bytes through the WebSocket and back, including bytes sent before open', async () => {
    const server = startEchoWebSocketServer();
    const bridge = startGrpcWebSocketBridge(`ws://127.0.0.1:${server.port}${RUNNER_GRPC_WS_PATH}`);
    cleanups.push(() => bridge.close());
    expect(bridge.address).toMatch(/^127\.0\.0\.1:\d+$/);

    const received: number[] = [];
    const done = new Promise<void>((resolve) => {
      void connectTcp(bridge.address, (chunk) => {
        received.push(...chunk);
        if (received.length >= 6) resolve();
      }).then((socket) => {
        socket.write(new Uint8Array([1, 2, 3]));
        setTimeout(() => socket.write(new Uint8Array([4, 5, 6])), 50);
      });
    });
    await done;
    expect(received).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('sends the runner bearer token on the WebSocket upgrade', async () => {
    const seen: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req, srv) => {
        seen.push(req.headers.get('authorization'));
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: { message: (ws, message) => void ws.send(message) },
    });
    cleanups.push(() => server.stop(true));
    const bridge = startGrpcWebSocketBridge(`ws://127.0.0.1:${server.port}${RUNNER_GRPC_WS_PATH}`, {
      bearerToken: 'runner-secret-token',
    });
    cleanups.push(() => bridge.close());

    const echoed = new Promise<void>((resolve) => {
      void connectTcp(bridge.address, () => resolve()).then((socket) => {
        socket.write(new Uint8Array([7]));
      });
    });
    await echoed;
    expect(seen).toEqual(['Bearer runner-secret-token']);
  });

  test('closes the TCP connection when the carrier cannot be reached', async () => {
    const server = startEchoWebSocketServer();
    const port = server.port;
    server.stop(true);
    const bridge = startGrpcWebSocketBridge(`ws://127.0.0.1:${port}${RUNNER_GRPC_WS_PATH}`);
    cleanups.push(() => bridge.close());
    const [hostname, tcpPort] = bridge.address.split(':');
    const closed = new Promise<void>((resolve) => {
      void Bun.connect({
        hostname,
        port: Number(tcpPort),
        socket: { data: () => {}, close: () => resolve() },
      });
    });
    await closed;
  });
});

describe('runner gRPC endpoint resolution', () => {
  test('explicit endpoint wins (private network)', () => {
    expect(
      requireRunnerGrpcEndpoint({
        RUNNER_GRPC_ENDPOINT: 'funny-server.railway.internal:50051',
        TEAM_SERVER_URL: 'https://funny.example',
      }),
    ).toBe('funny-server.railway.internal:50051');
  });

  test('derives the WebSocket carrier from TEAM_SERVER_URL', () => {
    expect(requireRunnerGrpcEndpoint({ TEAM_SERVER_URL: 'https://funny.example/app?x=1' })).toBe(
      `wss://funny.example${RUNNER_GRPC_WS_PATH}`,
    );
    expect(requireRunnerGrpcEndpoint({ TEAM_SERVER_URL: 'http://localhost:3001' })).toBe(
      `ws://localhost:3001${RUNNER_GRPC_WS_PATH}`,
    );
  });

  test('fails without either setting', () => {
    expect(() => requireRunnerGrpcEndpoint({})).toThrow('RUNNER_GRPC_ENDPOINT is required');
  });

  test('recognizes WebSocket endpoints', () => {
    expect(isWebSocketEndpoint(' wss://a/b')).toBe(true);
    expect(isWebSocketEndpoint('host:50051')).toBe(false);
    expect(isWebSocketEndpoint('https://host:443')).toBe(false);
  });
});
