/**
 * PTY daemon socket framing — partial writes and chunk boundaries (#213).
 *
 * A large paste or a burst of PTY output used to lose the tail of an NDJSON
 * line when `socket.write()` accepted only part of it, and to corrupt
 * multibyte UTF-8 characters split across two socket chunks.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  NdjsonLineDecoder,
  SocketWriteQueue,
  type WritableSocket,
} from '../../services/pty-socket-framing.js';

const encoder = new TextEncoder();

/** A socket that accepts at most `budget` bytes until given more. */
function throttledSocket(budget: number) {
  const received: number[] = [];
  const socket: WritableSocket & { budget: number; received: number[] } = {
    budget,
    received,
    write(data) {
      const n = Math.min(this.budget, data.byteLength);
      this.budget -= n;
      for (const b of data.subarray(0, n)) received.push(b);
      return n;
    },
  };
  return socket;
}

describe('NdjsonLineDecoder', () => {
  test('keeps a multibyte character split across chunks intact', () => {
    const decoder = new NdjsonLineDecoder();
    const bytes = encoder.encode(JSON.stringify({ data: 'héllo 🎉 世界' }) + '\n');
    const lines: string[] = [];
    // Feed one byte at a time: every multibyte character is split.
    for (let i = 0; i < bytes.byteLength; i++) {
      lines.push(...decoder.push(bytes.subarray(i, i + 1)));
    }
    expect(lines).toEqual([JSON.stringify({ data: 'héllo 🎉 世界' })]);
    expect(JSON.parse(lines[0]).data).toBe('héllo 🎉 世界');
  });

  test('yields only complete lines and skips empty ones', () => {
    const decoder = new NdjsonLineDecoder();
    expect(decoder.push(encoder.encode('{"a":1}\n\n{"b":'))).toEqual(['{"a":1}']);
    expect(decoder.push(encoder.encode('2}\n'))).toEqual(['{"b":2}']);
  });
});

describe('SocketWriteQueue', () => {
  test('keeps what a backpressured write did not take and sends it on drain, in order', () => {
    const socket = throttledSocket(5);
    const queue = new SocketWriteQueue(socket);

    expect(queue.write('{"x":"ñandú"}\n')).toBe(true);
    expect(queue.write('{"y":2}\n')).toBe(true);
    expect(socket.received.length).toBe(5);
    expect(queue.pendingBytes).toBeGreaterThan(0);

    socket.budget = 3;
    queue.drain();
    expect(socket.received.length).toBe(8);

    socket.budget = Infinity;
    queue.drain();
    expect(queue.pendingBytes).toBe(0);
    expect(new TextDecoder().decode(new Uint8Array(socket.received))).toBe(
      '{"x":"ñandú"}\n{"y":2}\n',
    );
  });

  test('refuses a write that would exceed the pending cap', () => {
    const socket = throttledSocket(0);
    const queue = new SocketWriteQueue(socket, 10);
    expect(queue.write('12345678\n')).toBe(true);
    expect(queue.write('abc\n')).toBe(false);
    expect(queue.pendingBytes).toBe(9);
  });

  test('treats a negative write result (closed socket) as nothing written', () => {
    const queue = new SocketWriteQueue({ write: () => -1 });
    expect(queue.write('{}\n')).toBe(true);
    expect(queue.pendingBytes).toBe(3);
  });
});

describe('over a real Unix socket', () => {
  test('a multi-megabyte multibyte line arrives whole', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-framing-'));
    const path = join(dir, 's.sock');
    const payload = 'ü🎉世'.repeat(400_000); // ~4 MB of multibyte text
    const expected = JSON.stringify({ evt: 'data', id: 't', data: payload });

    const received = Promise.withResolvers<string[]>();
    const reader = new NdjsonLineDecoder();
    const lines: string[] = [];
    const server = Bun.listen({
      unix: path,
      socket: {
        data(_s, chunk) {
          lines.push(...reader.push(chunk));
          if (lines.length === 2) received.resolve(lines);
        },
      },
    });

    let writer: SocketWriteQueue | null = null;
    const client = await Bun.connect({
      unix: path,
      socket: {
        open(s) {
          writer = new SocketWriteQueue(s);
        },
        data() {},
        drain() {
          writer?.drain();
        },
      },
    });

    try {
      writer ??= new SocketWriteQueue(client);
      expect(writer.write(expected + '\n')).toBe(true);
      expect(writer.write('{"evt":"pong"}\n')).toBe(true);
      const got = await received.promise;
      expect(got[0].length).toBe(expected.length);
      expect(got[0] === expected).toBe(true);
      expect(got[1]).toBe('{"evt":"pong"}');
    } finally {
      client.end();
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
