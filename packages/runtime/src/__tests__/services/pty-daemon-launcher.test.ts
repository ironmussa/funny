/**
 * PTY daemon launcher — socket ping/shutdown timeouts.
 *
 * `Bun.connect` is stubbed so each test controls which socket callbacks fire
 * (pong, close, nothing at all) and the timeout paths can be driven with
 * fake timers instead of a real daemon.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { advanceTimersByTimeAsync } from '@funny/test-kit';

const dataDir = await (async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'pty-daemon-launcher-'));
})();

vi.mock('../../lib/data-dir.js', () => ({ DATA_DIR: dataDir }));
vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Imported after the mocks: the launcher reads DATA_DIR at import time.
const { isDaemonRunning, stopDaemon } = await import('../../services/pty-daemon-launcher.js');

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
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid !== FAKE_PID) throw new Error('unexpected pid');
    if (signal === 0 || signal === undefined) {
      if (!alive) throw new Error('ESRCH');
      return true;
    }
    alive = false;
    return true;
  });
  socket = { write: vi.fn(), end: vi.fn() };
  // SAFETY: the launcher only calls `Bun.connect({ unix, socket })` and uses `write` / `end`
  // on the socket, which FakeSocket provides; a full Bun Socket cannot be built in a test.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Bun.connect has complex overloads; simplified mock callback type is incompatible
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
    expect(socket.end).toHaveBeenCalledTimes(1);
  });

  test('resolves false when the socket closes without a pong', async () => {
    const pending = isDaemonRunning();
    handlers.close?.();
    await expect(pending).resolves.toBe(false);
  });

  test('resolves false (not throw) when the daemon never answers within 2s', async () => {
    const pending = isDaemonRunning();
    await advanceTimersByTimeAsync(1999);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(false);
  });
});

describe('stopDaemon', () => {
  test('a shutdown request that times out still checks for a graceful exit', async () => {
    const pending = stopDaemon();
    expect(socket.write).toHaveBeenCalledWith(JSON.stringify({ cmd: 'shutdown' }) + '\n');
    // Daemon exits but never closes the socket — the 3s timeout must not escalate to SIGTERM.
    alive = false;
    await advanceTimersByTimeAsync(3000 + 500);
    await expect(pending).resolves.toBeUndefined();
    expect(process.kill).not.toHaveBeenCalledWith(FAKE_PID, 'SIGTERM');
  });
});
