/**
 * websocket-carrier.ts — public WebSocket → private gRPC listener byte pipe.
 * Uses real Bun sockets: a TCP echo listener stands in for the gRPC listener.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  carrierTargetFor,
  createRunnerGrpcWebSocketCarrier,
  routeRunnerCarrier,
  unauthenticatedCarrierPolicyFromEnv,
  withRunnerCarrier,
  type RunnerGrpcWebSocketCarrierOptions,
} from '../../services/grpc/websocket-carrier.js';

const VALID_TOKEN = 'runner-token-ok';
const authenticate = async (token: string) => (token === VALID_TOKEN ? 'runner-1' : null);

function carrierFor(
  port: number,
  extra: Partial<RunnerGrpcWebSocketCarrierOptions> = {},
): ReturnType<typeof createRunnerGrpcWebSocketCarrier> {
  return createRunnerGrpcWebSocketCarrier({
    target: { hostname: '127.0.0.1', port },
    authenticate,
    ...extra,
  });
}

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
      if (new URL(req.url).pathname === carrier.path) {
        return carrier.upgrade(req, srv as any, srv.requestIP(req)?.address ?? '');
      }
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

function openClient(port: number | undefined, path: string, token?: string): Promise<WebSocket> {
  const ws = token
    ? new WebSocket(`ws://127.0.0.1:${port}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      } as any)
    : new WebSocket(`ws://127.0.0.1:${port}${path}`);
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
    const carrier = carrierFor(echo.port);
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
    const carrier = carrierFor(port);
    const server = startServer(carrier);
    const ws = await openClient(server.port, carrier.path);
    expect(await nextClose(ws)).toBe(1011);
    expect(carrier.activeConnections()).toBe(0);
  });

  test('rejects text frames', async () => {
    const echo = startEchoListener();
    const carrier = carrierFor(echo.port);
    const server = startServer(carrier);
    const ws = await openClient(server.port, carrier.path);
    const closed = nextClose(ws);
    ws.send('hello');
    expect(await closed).toBe(1003);
  });

  test('refuses upgrades beyond capacity and non-upgrade requests', async () => {
    const echo = startEchoListener();
    const carrier = carrierFor(echo.port, { maxConnections: 1 });
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
      open: (_ws: unknown) => calls.push('engine-open'),
      message: (_ws: unknown, _message: unknown) => calls.push('engine-message'),
      close: (_ws: unknown, _code: number, _reason: string) => calls.push('engine-close'),
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
    expect(routeRunnerCarrier(other, {}, null, '')).toBeNull();
    const carrierReq = new Request('http://x/api/runner-grpc/ws');
    expect((routeRunnerCarrier(carrierReq, {}, null, '') as Response).status).toBe(404);
  });
});

/**
 * 0-security: unauthenticated upgrades must not be able to hold the carrier's
 * slots. A runner authenticates the upgrade with its token; tokenless (older)
 * runners get a small separate pool and a first-byte deadline.
 */
describe('runner gRPC WebSocket carrier — upgrade authentication', () => {
  const upgradeRequest = (token?: string) =>
    new Request('http://x/api/runner-grpc/ws', {
      headers: {
        upgrade: 'websocket',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  /** Accepts every upgrade without opening a socket (slots stay reserved). */
  const fakeServer = () => {
    const upgraded: Array<{ authenticated: boolean; address: string }> = [];
    return {
      upgraded,
      upgrade: (_req: Request, opts: { data: { authenticated: boolean; address: string } }) => {
        upgraded.push({ authenticated: opts.data.authenticated, address: opts.data.address });
        return true;
      },
    };
  };

  test('a valid runner token is upgraded as authenticated; a bad one gets 401', async () => {
    const carrier = carrierFor(1);
    const server = fakeServer();
    expect(
      await carrier.upgrade(upgradeRequest(VALID_TOKEN), server, '203.0.113.1'),
    ).toBeUndefined();
    expect(server.upgraded).toEqual([{ authenticated: true, address: '203.0.113.1' }]);
    expect((await carrier.upgrade(upgradeRequest('forged'), server, '203.0.113.1'))?.status).toBe(
      401,
    );
    expect(server.upgraded).toHaveLength(1);
  });

  test('tokenless upgrades are capped per address and in total', async () => {
    const carrier = carrierFor(1, {
      unauthenticated: { maxConnections: 3, maxPerAddress: 2, firstByteMs: 10_000 },
    });
    const server = fakeServer();
    expect(await carrier.upgrade(upgradeRequest(), server, '198.51.100.1')).toBeUndefined();
    expect(await carrier.upgrade(upgradeRequest(), server, '198.51.100.1')).toBeUndefined();
    expect((await carrier.upgrade(upgradeRequest(), server, '198.51.100.1'))?.status).toBe(429);
    expect(await carrier.upgrade(upgradeRequest(), server, '198.51.100.2')).toBeUndefined();
    expect((await carrier.upgrade(upgradeRequest(), server, '198.51.100.3'))?.status).toBe(503);
  });

  test('a full tokenless pool does not block authenticated runners', async () => {
    const carrier = carrierFor(1, {
      maxConnections: 10,
      unauthenticated: { maxConnections: 2, maxPerAddress: 2, firstByteMs: 10_000 },
    });
    const server = fakeServer();
    await carrier.upgrade(upgradeRequest(), server, 'attacker');
    await carrier.upgrade(upgradeRequest(), server, 'attacker');
    expect((await carrier.upgrade(upgradeRequest(), server, 'attacker2'))?.status).toBe(503);
    expect(await carrier.upgrade(upgradeRequest(VALID_TOKEN), server, 'runner')).toBeUndefined();
  });

  test('tokenless upgrades are refused when the policy disallows them', async () => {
    const carrier = carrierFor(1, { unauthenticated: false });
    expect((await carrier.upgrade(upgradeRequest(), fakeServer(), 'x'))?.status).toBe(401);
    expect(
      unauthenticatedCarrierPolicyFromEnv({ RUNNER_GRPC_WS_ALLOW_UNAUTHENTICATED: 'false' }),
    ).toBe(false);
    expect(unauthenticatedCarrierPolicyFromEnv({})).not.toBe(false);
  });

  test('a silent tokenless socket is closed after the first-byte deadline; a token keeps it', async () => {
    const echo = startEchoListener();
    const carrier = carrierFor(echo.port, {
      unauthenticated: { maxConnections: 4, maxPerAddress: 4, firstByteMs: 100 },
    });
    const server = startServer(carrier);

    const silent = await openClient(server.port, carrier.path);
    expect(await nextClose(silent)).toBe(1008);

    const talking = await openClient(server.port, carrier.path);
    const reply = nextMessage(talking);
    talking.send(new Uint8Array([1, 2, 3]));
    expect([...(await reply)]).toEqual([1, 2, 3]);

    const authenticated = await openClient(server.port, carrier.path, VALID_TOKEN);
    await Bun.sleep(250);
    expect(authenticated.readyState).toBe(WebSocket.OPEN);
    expect(talking.readyState).toBe(WebSocket.OPEN);
    // Closed and silent sockets gave their tokenless slots back.
    expect(carrier.activeConnections()).toBe(2);
  });

  test('a real runner bridge authenticates the upgrade with its token', async () => {
    const echo = startEchoListener();
    const carrier = carrierFor(echo.port, { unauthenticated: false });
    const server = startServer(carrier);
    const ws = await openClient(server.port, carrier.path, VALID_TOKEN);
    const reply = nextMessage(ws);
    ws.send(new Uint8Array([9]));
    expect([...(await reply)]).toEqual([9]);
    await expect(openClient(server.port, carrier.path)).rejects.toThrow();
  });
});
