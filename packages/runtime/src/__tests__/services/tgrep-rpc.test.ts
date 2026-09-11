import { createServer, type Socket } from 'node:net';

import { afterEach, describe, expect, test } from 'vitest';

import { tgrepRpc } from '../../services/tgrep-rpc.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function server(reply: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.once('data', () => reply(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return address.port;
}

describe('bounded tgrep RPC', () => {
  test('assembles fragmented UTF-8 replies', async () => {
    const port = await server((socket) => {
      const reply = Buffer.from('{"jsonrpc":"2.0","id":1,"result":"café"}\n');
      const split = reply.indexOf(Buffer.from('é')) + 1;
      socket.write(reply.subarray(0, split));
      setTimeout(() => socket.end(reply.subarray(split)), 5);
    });
    expect(await tgrepRpc(port, 'search', {}, new AbortController().signal)).toBe('café');
  });
  test.each([
    'not json\n',
    '{"jsonrpc":"2.0","id":2,"result":{}}\n',
    '{"jsonrpc":"2.0","id":1,"error":{"message":"private"}}\n',
    '{"jsonrpc":"2.0","id":1}\n',
  ])('rejects invalid envelopes', async (reply) => {
    const port = await server((socket) => socket.end(reply));
    await expect(tgrepRpc(port, 'search', {}, new AbortController().signal)).rejects.toThrow(
      'protocol',
    );
  });
  test('limits replies without a newline', async () => {
    const port = await server((socket) => socket.write('x'.repeat(100)));
    await expect(
      tgrepRpc(port, 'search', {}, new AbortController().signal, { timeoutMs: 100, maxBytes: 16 }),
    ).rejects.toThrow('reply-limit');
  });
  test('enforces deadlines and cancellation', async () => {
    const port = await server(() => undefined);
    await expect(
      tgrepRpc(port, 'search', {}, new AbortController().signal, { timeoutMs: 10, maxBytes: 100 }),
    ).rejects.toThrow('timeout');
    const controller = new AbortController();
    const pending = tgrepRpc(port, 'search', {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    await expect(tgrepRpc(port, 'search', {}, controller.signal)).rejects.toThrow('cancelled');
  });
  test('rejects premature connection closure', async () => {
    const port = await server((socket) => socket.end('{'));
    await expect(tgrepRpc(port, 'search', {}, new AbortController().signal)).rejects.toThrow(
      'closed',
    );
  });
});
