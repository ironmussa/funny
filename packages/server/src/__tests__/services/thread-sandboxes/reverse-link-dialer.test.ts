/**
 * reverse-link/dialer.ts — the server end of the reverse runner link. A Bun
 * WebSocket server stands in for the sandbox relay, a TCP server for the
 * server's own reverse-link listener.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  REVERSE_LINK_OPEN,
  REVERSE_LINK_PATH,
  REVERSE_LINK_SECRET_HEADER,
} from '@funny/shared/reverse-link';
import type { ServerWebSocket } from 'bun';

import {
  reverseLinkUrl,
  startReverseLinkDialer,
} from '../../../services/thread-sandboxes/reverse-link/dialer.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const until = async (check: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await Bun.sleep(5);
  }
};

const text = (frames: Array<string | Uint8Array>) =>
  frames
    .filter((f): f is Uint8Array => typeof f !== 'string')
    .map((f) => new TextDecoder().decode(f))
    .join('');

/** A relay that records each spare with the request that opened it. */
function startFakeRelay() {
  const spares: Array<{
    ws: ServerWebSocket<{ frames: Array<string | Uint8Array> }>;
    headers: Headers;
    url: string;
  }> = [];
  const server = Bun.serve<{ frames: Array<string | Uint8Array>; headers: Headers; url: string }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname !== REVERSE_LINK_PATH)
        return new Response('no', { status: 404 });
      const data = { frames: [], headers: req.headers, url: req.url };
      return srv.upgrade(req, { data }) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        spares.push({ ws: ws as any, headers: ws.data.headers, url: ws.data.url });
      },
      message(ws, message) {
        ws.data.frames.push(typeof message === 'string' ? message : new Uint8Array(message));
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, spares };
}

/** The server listener: answers every chunk with `pong:<chunk>`. */
function startTarget() {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: (socket, chunk) => void socket.write(`pong:${new TextDecoder().decode(chunk)}`),
    },
  });
  cleanups.push(() => listener.stop(true));
  return { hostname: '127.0.0.1', port: listener.port };
}

describe('reverse link dialer', () => {
  test('keeps spares open with the secret and the ingress credentials', async () => {
    const relay = startFakeRelay();
    const dialer = startReverseLinkDialer({
      ingress: { url: `${relay.url}/?_token=abc`, headers: { authorization: 'Bearer ibp_1' } },
      secret: 's3cret',
      target: startTarget(),
      spares: 2,
    });
    cleanups.push(() => dialer.close());

    await until(() => relay.spares.length === 2 && dialer.spareCount() === 2);
    const [first] = relay.spares;
    expect(first.headers.get(REVERSE_LINK_SECRET_HEADER)).toBe('s3cret');
    expect(first.headers.get('authorization')).toBe('Bearer ibp_1');
    expect(new URL(first.url).searchParams.get('_token')).toBe('abc');
  });

  test('an announced spare pipes to the server listener and is replaced', async () => {
    const relay = startFakeRelay();
    const dialer = startReverseLinkDialer({
      ingress: { url: relay.url, headers: {} },
      secret: 's',
      target: startTarget(),
      spares: 1,
    });
    cleanups.push(() => dialer.close());
    await until(() => relay.spares.length === 1);

    const spare = relay.spares[0];
    spare.ws.send(REVERSE_LINK_OPEN);
    spare.ws.send(new TextEncoder().encode('ping'));
    await until(() => text(spare.ws.data.frames) === 'pong:ping');

    expect(dialer.pipeCount()).toBe(1);
    // The pool is refilled for the runner's next connection.
    await until(() => relay.spares.length === 2 && dialer.spareCount() === 1);
  });

  test('closing the sandbox side of a pipe closes it', async () => {
    const relay = startFakeRelay();
    const dialer = startReverseLinkDialer({
      ingress: { url: relay.url, headers: {} },
      secret: 's',
      target: startTarget(),
      spares: 1,
    });
    cleanups.push(() => dialer.close());
    await until(() => relay.spares.length === 1);
    relay.spares[0].ws.send(REVERSE_LINK_OPEN);
    await until(() => dialer.pipeCount() === 1);
    relay.spares[0].ws.close();
    await until(() => dialer.pipeCount() === 0);
  });

  test('a frame before the announcement is a protocol error', async () => {
    const relay = startFakeRelay();
    const dialer = startReverseLinkDialer({
      ingress: { url: relay.url, headers: {} },
      secret: 's',
      target: startTarget(),
      spares: 1,
      backoff: { baseMs: 1, maxMs: 1 },
    });
    cleanups.push(() => dialer.close());
    await until(() => relay.spares.length === 1);
    relay.spares[0].ws.send(new Uint8Array([1]));
    await until(() => relay.spares[0].ws.readyState === 3);
    expect(dialer.pipeCount()).toBe(0);
  });

  test('an unreachable sandbox backs off and reports itself unhealthy', async () => {
    const closed = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = closed.port;
    closed.stop(true);
    let unhealthy = 0;
    const dialer = startReverseLinkDialer({
      ingress: { url: `http://127.0.0.1:${port}`, headers: {} },
      secret: 's',
      target: startTarget(),
      spares: 1,
      backoff: { baseMs: 1, maxMs: 5 },
      unhealthyAfter: 3,
      onUnhealthy: () => (unhealthy += 1),
    });
    cleanups.push(() => dialer.close());
    await until(() => unhealthy === 1);
  });

  test('close stops the spares and the redial', async () => {
    const relay = startFakeRelay();
    const dialer = startReverseLinkDialer({
      ingress: { url: relay.url, headers: {} },
      secret: 's',
      target: startTarget(),
      spares: 2,
    });
    await until(() => relay.spares.length === 2);
    dialer.close();
    await until(() => relay.spares.every((s) => s.ws.readyState === 3));
    await Bun.sleep(30);
    expect(relay.spares).toHaveLength(2);
  });

  test('the dial URL is the ingress origin and query on the reverse-link path', () => {
    expect(reverseLinkUrl('https://a-7810.on.boat.dev/?_token=x')).toBe(
      `wss://a-7810.on.boat.dev${REVERSE_LINK_PATH}?_token=x`,
    );
    expect(reverseLinkUrl('http://127.0.0.1:9')).toBe(`ws://127.0.0.1:9${REVERSE_LINK_PATH}`);
  });
});
