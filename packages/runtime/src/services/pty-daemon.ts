/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Persistent PTY daemon — runs as a standalone Bun process that owns all PTY
 * shell processes. Survives server restarts so terminals stay alive.
 *
 * Communicates with the funny server via Unix domain socket using NDJSON.
 * Each PTY session has a headless xterm.js instance for state capture.
 *
 * Usage: bun run packages/runtime/src/services/pty-daemon.ts
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Subprocess } from 'bun';

// ── Configuration ────────────────────────────────────────────────────

const DATA_DIR = process.env.FUNNY_DATA_DIR
  ? resolve(process.env.FUNNY_DATA_DIR)
  : resolve(homedir(), '.funny');

mkdirSync(DATA_DIR, { recursive: true });

const SOCKET_PATH = resolve(DATA_DIR, 'pty.sock');
const PID_FILE = resolve(DATA_DIR, 'pty-daemon.pid');
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Standalone daemon process — use stderr for logging (no access to project logger)
const daemonLog = (...args: unknown[]) => process.stderr.write(`${args.join(' ')}\n`);

// ── Types ────────────────────────────────────────────────────────────

interface DaemonSession {
  id: string;
  proc: Subprocess;
  headless: InstanceType<typeof HeadlessTerminal>;
  serialize: SerializeAddon;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
}

interface SpawnCmd {
  cmd: 'spawn';
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  shell?: string;
  env?: Record<string, string>;
}

interface WriteCmd {
  cmd: 'write';
  id: string;
  data: string;
}

interface ResizeCmd {
  cmd: 'resize';
  id: string;
  cols: number;
  rows: number;
}

interface KillCmd {
  cmd: 'kill';
  id: string;
}

interface ListCmd {
  cmd: 'list';
}

interface CaptureCmd {
  cmd: 'capture';
  id: string;
}

interface ShutdownCmd {
  cmd: 'shutdown';
}

interface PingCmd {
  cmd: 'ping';
}

interface SignalCmd {
  cmd: 'signal';
  id: string;
  signal: number;
}

type DaemonCommand =
  | SpawnCmd
  | WriteCmd
  | ResizeCmd
  | KillCmd
  | ListCmd
  | CaptureCmd
  | ShutdownCmd
  | PingCmd
  | SignalCmd;

// ── Session Management ───────────────────────────────────────────────

const sessions = new Map<string, DaemonSession>();
const clients = new Set<import('bun').Socket>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function broadcast(msg: object): void {
  const line = JSON.stringify(msg) + '\n';
  for (const client of clients) {
    try {
      client.write(line);
    } catch {
      // Client disconnected, will be cleaned up
    }
  }
}

function sendTo(socket: import('bun').Socket, msg: object): void {
  try {
    socket.write(JSON.stringify(msg) + '\n');
  } catch {
    // Client gone
  }
}

function resolveShell(shellId?: string): string {
  if (!shellId || shellId === 'default') {
    return process.env.SHELL || 'bash';
  }
  return shellId;
}

function spawnSession(cmd: SpawnCmd): void {
  if (sessions.has(cmd.id)) {
    broadcast({ evt: 'error', id: cmd.id, error: 'Session already exists' });
    return;
  }

  const shell = resolveShell(cmd.shell);
  const cols = cmd.cols || 80;
  const rows = cmd.rows || 24;
  const cwd = cmd.cwd || process.cwd();

  try {
    const headless = new HeadlessTerminal({
      cols,
      rows,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const serialize = new SerializeAddon();
    headless.loadAddon(serialize);

    const ptyEnv = { ...process.env, ...(cmd.env || {}) } as Record<string, string>;

    const id = cmd.id;
    const proc = Bun.spawn([shell], {
      cwd,
      env: ptyEnv,
      terminal: {
        cols,
        rows,
        data(_terminal, data) {
          const str = data.toString();
          // Track state in headless terminal
          headless.write(str);
          // Broadcast to all connected servers
          broadcast({ evt: 'data', id, data: str });
        },
        exit(_terminal, exitCode) {
          broadcast({ evt: 'exit', id, exitCode });
          const session = sessions.get(id);
          if (session) {
            session.headless.dispose();
            sessions.delete(id);
          }
          resetIdleTimer();
        },
      },
    });

    sessions.set(id, { id, proc, headless, serialize, cwd, shell, cols, rows });
    broadcast({ evt: 'spawned', id });
    resetIdleTimer();

    daemonLog(`[pty-daemon] Session spawned: ${id} (shell=${shell}, cwd=${cwd})`);
  } catch (err: any) {
    broadcast({ evt: 'error', id: cmd.id, error: err?.message ?? 'Failed to spawn' });
    daemonLog(`[pty-daemon] Spawn failed: ${cmd.id}`, err?.message);
  }
}

function writeToSession(id: string, data: string): void {
  const session = sessions.get(id);
  if (session) {
    try {
      (session.proc as any).terminal?.write(data);
    } catch (err: any) {
      daemonLog(`[pty-daemon] Write failed: ${id}`, err?.message);
    }
  }
}

function resizeSession(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (session) {
    try {
      (session.proc as any).terminal?.resize(cols, rows);
      session.headless.resize(cols, rows);
      session.cols = cols;
      session.rows = rows;
    } catch (err: any) {
      daemonLog(`[pty-daemon] Resize failed: ${id}`, err?.message);
    }
  }
}

function signalSession(id: string, sig: number): void {
  const session = sessions.get(id);
  if (session) {
    try {
      session.proc.kill(sig);
      daemonLog(`[pty-daemon] Signal ${sig} sent to session: ${id}`);
    } catch (err: any) {
      daemonLog(`[pty-daemon] Signal failed: ${id}`, err?.message);
    }
  }
}

function killSession(id: string): void {
  const session = sessions.get(id);
  if (session) {
    sessions.delete(id);
    try {
      session.headless.dispose();
      session.proc.kill();
    } catch {
      // Process may already be gone
    }
    daemonLog(`[pty-daemon] Session killed: ${id}`);
    resetIdleTimer();
  }
}

function listSessions(): Array<{
  id: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
}> {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    cwd: s.cwd,
    shell: s.shell,
    cols: s.cols,
    rows: s.rows,
  }));
}

function signalSession(id: string, sig: number): void {
  const session = sessions.get(id);
  if (session) {
    try {
      session.proc.kill(sig);
      daemonLog(`[pty-daemon] Signal ${sig} sent to: ${id}`);
    } catch (err: any) {
      daemonLog(`[pty-daemon] Signal failed: ${id}`, err?.message);
    }
  }
}

function captureSession(id: string): string | null {
  const session = sessions.get(id);
  if (!session) return null;
  try {
    return session.serialize.serialize();
  } catch (err: any) {
    daemonLog(`[pty-daemon] Capture failed: ${id}`, err?.message);
    return null;
  }
}

// ── Idle Timer ───────────────────────────────────────────────────────

function resetIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  if (sessions.size === 0 && clients.size === 0) {
    idleTimer = setTimeout(() => {
      daemonLog('[pty-daemon] Idle timeout — shutting down');
      gracefulShutdown();
    }, IDLE_TIMEOUT_MS);
  }
}

// ── Command Handler ──────────────────────────────────────────────────

function handleCommand(socket: import('bun').Socket, msg: DaemonCommand): void {
  switch (msg.cmd) {
    case 'spawn':
      spawnSession(msg);
      break;
    case 'write':
      writeToSession(msg.id, msg.data);
      break;
    case 'resize':
      resizeSession(msg.id, msg.cols, msg.rows);
      break;
    case 'signal':
      signalSession(msg.id, msg.signal);
      break;
    case 'kill':
      killSession(msg.id);
      break;
    case 'list':
      sendTo(socket, { evt: 'sessions', sessions: listSessions() });
      break;
    case 'capture':
      sendTo(socket, { evt: 'captured', id: msg.id, state: captureSession(msg.id) });
      break;
    case 'ping':
      sendTo(socket, { evt: 'pong' });
      break;
    case 'shutdown':
      daemonLog('[pty-daemon] Shutdown requested');
      gracefulShutdown();
      break;
  }
}

// ── Socket Server ────────────────────────────────────────────────────

// Remove stale socket file
if (existsSync(SOCKET_PATH)) {
  try {
    unlinkSync(SOCKET_PATH);
  } catch {
    // May fail if another daemon is running — will error on listen
  }
}

// Per-client line buffer for NDJSON parsing
const lineBuffers = new WeakMap<import('bun').Socket, string>();

const server = Bun.listen({
  unix: SOCKET_PATH,
  socket: {
    open(socket) {
      clients.add(socket);
      lineBuffers.set(socket, '');
      resetIdleTimer();
      daemonLog(`[pty-daemon] Client connected (total: ${clients.size})`);
    },

    data(socket, data) {
      let buffer = (lineBuffers.get(socket) ?? '') + data.toString();

      // Process complete NDJSON lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (line.length === 0) continue;

        try {
          const msg = JSON.parse(line) as DaemonCommand;
          handleCommand(socket, msg);
        } catch {
          daemonLog(`[pty-daemon] Invalid message: ${line.slice(0, 200)}`);
        }
      }

      lineBuffers.set(socket, buffer);
    },

    close(socket) {
      clients.delete(socket);
      lineBuffers.delete(socket);
      resetIdleTimer();
      daemonLog(`[pty-daemon] Client disconnected (total: ${clients.size})`);
    },

    error(_socket, error) {
      daemonLog('[pty-daemon] Socket error:', error.message);
    },
  },
});

// ── PID File ─────────────────────────────────────────────────────────

writeFileSync(PID_FILE, String(process.pid));

// ── Graceful Shutdown ────────────────────────────────────────────────

function gracefulShutdown(): void {
  daemonLog('[pty-daemon] Shutting down...');

  // Kill all PTY sessions
  for (const [, session] of sessions) {
    try {
      session.headless.dispose();
      session.proc.kill();
    } catch {}
  }
  sessions.clear();

  // Close socket server
  try {
    server.stop();
  } catch {}

  // Clean up files
  try {
    unlinkSync(SOCKET_PATH);
  } catch {}
  try {
    unlinkSync(PID_FILE);
  } catch {}

  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ── Startup ──────────────────────────────────────────────────────────

daemonLog(`[pty-daemon] Started (pid=${process.pid})`);
daemonLog(`[pty-daemon] Socket: ${SOCKET_PATH}`);
daemonLog(`[pty-daemon] PID file: ${PID_FILE}`);

resetIdleTimer();
