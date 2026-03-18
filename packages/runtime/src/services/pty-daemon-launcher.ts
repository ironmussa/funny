/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Manages the lifecycle of the PTY daemon from the server side:
 * start, health-check, and stop.
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';

import { DATA_DIR } from '../lib/data-dir.js';
import { log } from '../lib/logger.js';

const SOCKET_PATH = resolve(DATA_DIR, 'pty.sock');
const PID_FILE = resolve(DATA_DIR, 'pty-daemon.pid');

/** Path to the daemon entry point (resolved relative to this file). */
const DAEMON_ENTRY = resolve(import.meta.dir, 'pty-daemon.ts');

export { SOCKET_PATH };

/**
 * Check if the daemon process is alive by reading the PID file
 * and sending signal 0.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the daemon PID from the PID file.
 * Returns null if the file doesn't exist or is invalid.
 */
function readPid(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Clean up stale PID and socket files.
 */
function cleanupStaleFiles(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {}
  try {
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  } catch {}
}

/**
 * Check if the daemon is currently running and responsive.
 */
export async function isDaemonRunning(): Promise<boolean> {
  const pid = readPid();
  if (!pid || !isProcessAlive(pid)) {
    return false;
  }

  // PID is alive, verify socket is connectable
  if (!existsSync(SOCKET_PATH)) {
    return false;
  }

  // Try a quick ping/pong
  try {
    const connected = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 2000);

      Bun.connect({
        unix: SOCKET_PATH,
        socket: {
          open(socket) {
            socket.write(JSON.stringify({ cmd: 'ping' }) + '\n');
          },
          data(socket, data) {
            const str = data.toString();
            if (str.includes('"pong"')) {
              clearTimeout(timeout);
              socket.end();
              resolve(true);
            }
          },
          close() {
            clearTimeout(timeout);
            resolve(false);
          },
          error() {
            clearTimeout(timeout);
            resolve(false);
          },
        },
      });
    });

    return connected;
  } catch {
    return false;
  }
}

/**
 * Start the daemon if not already running.
 * Returns true if daemon is running after this call.
 */
export async function ensureDaemonRunning(): Promise<boolean> {
  // Check if already running
  if (await isDaemonRunning()) {
    log.info('PTY daemon already running', {
      namespace: 'pty-daemon-launcher',
      pid: readPid(),
    });
    return true;
  }

  // Clean up stale files from previous daemon
  cleanupStaleFiles();

  log.info('Starting PTY daemon', {
    namespace: 'pty-daemon-launcher',
    entry: DAEMON_ENTRY,
  });

  try {
    const proc = Bun.spawn(['bun', 'run', DAEMON_ENTRY], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        FUNNY_DATA_DIR: DATA_DIR,
      },
    });

    // Detach — don't keep server alive waiting for daemon
    proc.unref();

    // Wait for daemon to be ready (socket appears + responds to ping)
    const maxWaitMs = 5000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await Bun.sleep(200);
      if (await isDaemonRunning()) {
        log.info('PTY daemon started successfully', {
          namespace: 'pty-daemon-launcher',
          pid: readPid(),
        });
        return true;
      }
    }

    log.error('PTY daemon failed to start within timeout', {
      namespace: 'pty-daemon-launcher',
    });
    return false;
  } catch (err: any) {
    log.error('Failed to start PTY daemon', {
      namespace: 'pty-daemon-launcher',
      error: err?.message,
    });
    return false;
  }
}

/**
 * Stop the daemon gracefully.
 */
export async function stopDaemon(): Promise<void> {
  const pid = readPid();
  if (!pid || !isProcessAlive(pid)) {
    cleanupStaleFiles();
    return;
  }

  // Try graceful shutdown via socket
  if (existsSync(SOCKET_PATH)) {
    try {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 3000);

        Bun.connect({
          unix: SOCKET_PATH,
          socket: {
            open(socket) {
              socket.write(JSON.stringify({ cmd: 'shutdown' }) + '\n');
            },
            close() {
              clearTimeout(timeout);
              resolve();
            },
            error() {
              clearTimeout(timeout);
              resolve();
            },
            data() {},
          },
        });
      });

      // Wait briefly for process to exit
      await Bun.sleep(500);

      if (!isProcessAlive(pid)) {
        log.info('PTY daemon stopped gracefully', { namespace: 'pty-daemon-launcher' });
        cleanupStaleFiles();
        return;
      }
    } catch {
      // Fall through to SIGTERM
    }
  }

  // Force kill
  try {
    process.kill(pid, 'SIGTERM');
    await Bun.sleep(1000);

    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  } catch {}

  cleanupStaleFiles();
  log.info('PTY daemon stopped', { namespace: 'pty-daemon-launcher' });
}
