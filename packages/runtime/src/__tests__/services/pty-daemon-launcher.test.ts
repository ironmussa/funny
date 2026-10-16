/**
 * PTY daemon launcher — socket ping/shutdown timeouts.
 *
 * `Bun.connect` is stubbed so each test controls which socket callbacks fire
 * (pong, close, nothing at all) and the timeout paths can be driven with
 * fake timers instead of a real daemon.
 */

import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const dataDir = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs');
  const { tmpdir } = require('os') as typeof import('os');
  const { join } = require('path') as typeof import('path');
  return mkdtempSync(join(tmpdir(), 'pty-daemon-launcher-'));
});

// `import.meta.dir` (used for DAEMON_ENTRY) is Bun-only and undefined under vitest.
vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  const resolve = (...parts: (string | undefined)[]) =>
    actual.resolve(...parts.map((part) => part ?? '.'));
  return { ...actual, default: { ...actual, resolve }, resolve };
});
vi.mock('../../lib/data-dir.js', () => ({ DATA_DIR: dataDir }));
vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { isDaemonRunning, stopDaemon } from '../../services/pty-daemon-launcher.js';

type SocketHandlers = {
  open?: (socket: FakeSocket) => void;
  data?: (socket: FakeSocket, data: Buffer) => void;
  close?: () => void;
  error?: () => void;
};
type FakeSocket = { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };

const FAKE_PID = 424242;
let handlers: SocketHandlers;
let socket: FakeSocket;
let alive: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  writeFileSync(join(dataDir, 'pty-daemon.pid'), String(FAKE_PID));
  writeFileSync(join(dataDir, 'pty.sock'), '');
  alive = true;
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (pid !== FAKE_PID) throw new Error('unexpected pid');
    if (signal === 0 || signal === undefined) {
      if (!alive) throw new Error('ESRCH');
      return true;
    }
    alive = false;
    return true;
  }) as typeof process.kill);
  socket = { write: vi.fn(), end: vi.fn() };
  vi.spyOn(Bun, 'connect').mockImplementation(((opts: { socket: SocketHandlers }) => {
    handlers = opts.socket;
    handlers.open?.(socket);
    return Promise.resolve(socket);
  }) as unknown as typeof Bun.connect);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }));

describe('isDaemonRunning', () => {
  test('resolves true on pong and ends the socket', async () => {
    const pending = isDaemonRunning();
    handlers.data?.(socket, Buffer.from('{"type":"pong"}\n'));
    await expect(pending).resolves.toBe(true);
    expect(socket.end).toHaveBeenCalledOnce();
  });

  test('resolves false when the socket closes without a pong', async () => {
    const pending = isDaemonRunning();
    handlers.close?.();
    await expect(pending).resolves.toBe(false);
  });

  test('resolves false (not throw) when the daemon never answers within 2s', async () => {
    const pending = isDaemonRunning();
    await vi.advanceTimersByTimeAsync(1999);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(false);
  });
});

describe('stopDaemon', () => {
  test('a shutdown request that times out still checks for a graceful exit', async () => {
    const pending = stopDaemon();
    expect(socket.write).toHaveBeenCalledWith(JSON.stringify({ cmd: 'shutdown' }) + '\n');
    // Daemon exits but never closes the socket — the 3s timeout must not escalate to SIGTERM.
    alive = false;
    await vi.advanceTimersByTimeAsync(3000 + 500);
    await expect(pending).resolves.toBeUndefined();
    expect(process.kill).not.toHaveBeenCalledWith(FAKE_PID, 'SIGTERM');
  });
});
