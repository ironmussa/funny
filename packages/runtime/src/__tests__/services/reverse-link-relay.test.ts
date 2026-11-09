/**
 * reverse-link-relay.ts — sandbox end of the reverse runner link. A plain
 * WebSocket client stands in for the server's dialer.
 */
import {
  REVERSE_LINK_OPEN,
  REVERSE_LINK_PATH,
  REVERSE_LINK_SECRET_HEADER,
} from '@funny/shared/reverse-link';
import { afterEach, describe, expect, test } from 'vitest';

import { startReverseLinkRelay, type ReverseLinkRelay } from '../../services/reverse-link-relay.js';

const SECRET = 'relay-test-secret';
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function startRelay(opts: { waitForSpareMs?: number } = {}): ReverseLinkRelay {
  const relay = startReverseLinkRelay({
    secret: SECRET,
    ingressPort: 0,
    loopbackPort: 0,
    ingressHost: '127.0.0.1',
    ...opts,
  });
  cleanups.push(() => relay.close());
  return relay;
}

const until = async (check: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await Bun.sleep(5);
  }
};

/** A spare the way the server opens it; `frames` records what the relay sends. */
function openSpare(relay: ReverseLinkRelay, secret = SECRET) {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.ingressPort}${REVERSE_LINK_PATH}`, {
    headers: { [REVERSE_LINK_SECRET_HEADER]: secret },
  } as any);
  ws.binaryType = 'arraybuffer';
  const frames: Array<string | Uint8Array> = [];
  let closed = false;
  ws.onmessage = (e) =>
    frames.push(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
  ws.onclose = () => (closed = true);
  cleanups.push(() => ws.close());
  return { ws, frames, isClosed: () => closed };
}

async function connectRunner(relay: ReverseLinkRelay) {
  const received: number[] = [];
  let closed = false;
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port: relay.loopbackPort,
    socket: {
      data: (_s, chunk) => {
        received.push(...chunk);
      },
      close: () => {
        closed = true;
      },
    },
  });
  cleanups.push(() => socket.end());
  return { socket, received, isClosed: () => closed };
}

const text = (bytes: Iterable<number>) => new TextDecoder().decode(new Uint8Array([...bytes]));
const binaryText = (frames: Array<string | Uint8Array>) =>
  frames
    .filter((f): f is Uint8Array => typeof f !== 'string')
    .map((f) => text(f))
    .join('');

describe('reverse link relay', () => {
  test('a runner connection takes a spare, which is announced and then pipes both ways', async () => {
    const relay = startRelay();
    const spare = openSpare(relay);
    await until(() => relay.spareCount() === 1);

    const runner = await connectRunner(relay);
    runner.socket.write('GET / HTTP/1.1\r\n\r\n');
    await until(() => binaryText(spare.frames).length > 0);

    expect(spare.frames[0]).toBe(REVERSE_LINK_OPEN);
    expect(binaryText(spare.frames)).toBe('GET / HTTP/1.1\r\n\r\n');
    expect(relay.spareCount()).toBe(0);

    spare.ws.send(new TextEncoder().encode('HTTP/1.1 204 No Content\r\n\r\n'));
    await until(() => runner.received.length > 0);
    expect(text(runner.received)).toBe('HTTP/1.1 204 No Content\r\n\r\n');
  });

  test('bytes a runner sends before any spare exists wait for the next one', async () => {
    const relay = startRelay();
    const runner = await connectRunner(relay);
    runner.socket.write('early');
    await Bun.sleep(20);

    const spare = openSpare(relay);
    await until(() => binaryText(spare.frames) === 'early');
    expect(spare.frames[0]).toBe(REVERSE_LINK_OPEN);
  });

  test('a runner connection with no spare in time is dropped', async () => {
    const relay = startRelay({ waitForSpareMs: 30 });
    const runner = await connectRunner(relay);
    await until(runner.isClosed);
  });

  test('closing the spare closes the runner connection, and vice versa', async () => {
    const relay = startRelay();
    const a = openSpare(relay);
    const b = openSpare(relay);
    await until(() => relay.spareCount() === 2);

    const first = await connectRunner(relay);
    first.socket.write('x');
    await until(() => a.frames.length > 0 || b.frames.length > 0);
    const used = a.frames.length > 0 ? a : b;
    used.ws.close();
    await until(first.isClosed);

    const second = await connectRunner(relay);
    second.socket.write('y');
    const other = used === a ? b : a;
    await until(() => binaryText(other.frames) === 'y');
    second.socket.end();
    await until(other.isClosed);
  });

  test('refuses a spare without the secret, and any other path', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.ingressPort}`;
    const wrong = await fetch(`${base}${REVERSE_LINK_PATH}`, {
      headers: { [REVERSE_LINK_SECRET_HEADER]: 'nope', upgrade: 'websocket' },
    });
    expect(wrong.status).toBe(401);
    const missing = await fetch(`${base}${REVERSE_LINK_PATH}`);
    expect(missing.status).toBe(401);
    expect((await fetch(`${base}/api/anything`)).status).toBe(404);

    const spare = openSpare(relay, 'nope');
    await until(spare.isClosed);
    expect(relay.spareCount()).toBe(0);
  });

  test('a frame from the server before the spare is assigned closes it', async () => {
    const relay = startRelay();
    const spare = openSpare(relay);
    await until(() => relay.spareCount() === 1);
    spare.ws.send(new Uint8Array([1, 2, 3]));
    await until(spare.isClosed);
    expect(relay.spareCount()).toBe(0);
  });
});
