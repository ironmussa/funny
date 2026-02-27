/**
 * PtyManager — spawns and manages interactive PTY sessions via a helper Node.js process.
 * This architecture avoids compatibility issues between Bun and node-pty on Windows.
 */

import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { createInterface } from 'readline';

import { log } from '../lib/logger.js';
import { wsBroker } from './ws-broker.js';

let helperProcess: ChildProcess | null = null;
let helperStdin: any = null; // Type as any to avoid strict stream types mismatch
const _pendingSpawns = new Set<string>();

// Ensure helper is running
function ensureHelper() {
  if (helperProcess && !helperProcess.killed) return;

  const helperPath = join(import.meta.dir, 'pty-helper.mjs');
  log.info('Spawning PTY helper process', { namespace: 'pty-manager', helperPath });

  helperProcess = spawn('node', [helperPath], {
    // ALL fds must be 'pipe' (not 'inherit') to prevent Windows handle inheritance.
    // When any fd uses 'inherit', Node sets bInheritHandles=TRUE in CreateProcess,
    // causing the child to inherit ALL parent handles — including the server's
    // listening socket. If the server dies without cleanup, the helper keeps the
    // port occupied indefinitely (ghost socket).
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  helperStdin = helperProcess.stdin;

  // Forward helper's stderr to server's stderr (replaces 'inherit')
  if (helperProcess.stderr) {
    helperProcess.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
  }

  if (helperProcess.stdout) {
    const rl = createInterface({
      input: helperProcess.stdout,
      terminal: false,
    });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        handleHelperMessage(msg);
      } catch (err) {
        log.error('Failed to parse PTY helper output', {
          namespace: 'pty-manager',
          line,
          error: err,
        });
      }
    });
  }

  helperProcess.on('exit', (code) => {
    log.warn('PTY helper process exited', { namespace: 'pty-manager', exitCode: code });
    helperProcess = null;
    helperStdin = null;
    // We might want to restart it immediately or on next demand
    // For now, let next action trigger restart
  });
}

function handleHelperMessage(msg: any) {
  const { type, data } = msg;

  switch (type) {
    case 'pty:data':
      if (data.ptyId) {
        // If the PTY is associated with a specific user (we don't track user mapping easily here anymore
        // without complex state, so we broadcast to all sessions for now or check if we can retrieve it).
        //
        // In the original code we had:
        // if (userId && userId !== '__local__') wsBroker.emitToUser(userId, event);
        // else wsBroker.emit(event);
        //
        // To keep it simple and since we lost the direct userId context in this event stream
        // (unless we store it in a map in this file), let's store it.

        const session = activeSessions.get(data.ptyId);
        const event = {
          type: 'pty:data' as const,
          threadId: '',
          data: { ptyId: data.ptyId, data: data.data },
        };

        if (session?.userId && session.userId !== '__local__') {
          wsBroker.emitToUser(session.userId, event);
        } else {
          wsBroker.emit(event);
        }
      }
      break;

    case 'pty:exit':
      if (data.ptyId) {
        const session = activeSessions.get(data.ptyId);
        log.info('PTY exited', {
          namespace: 'pty-manager',
          ptyId: data.ptyId,
          exitCode: data.exitCode,
        });

        const event = {
          type: 'pty:exit' as const,
          threadId: '',
          data: { ptyId: data.ptyId, exitCode: data.exitCode },
        };

        if (session?.userId && session.userId !== '__local__') {
          wsBroker.emitToUser(session.userId, event);
        } else {
          wsBroker.emit(event);
        }

        activeSessions.delete(data.ptyId);
      }
      break;
  }
}

// Track sessions just for user mapping
interface SessionMeta {
  userId: string;
  cwd: string;
}
const activeSessions = new Map<string, SessionMeta>();

function sendToHelper(type: string, args: any) {
  ensureHelper();
  if (helperStdin) {
    helperStdin.write(JSON.stringify({ type, ...args }) + '\n');
  }
}

export function spawnPty(
  id: string,
  cwd: string,
  cols: number,
  rows: number,
  userId: string,
  shell?: string,
): void {
  if (activeSessions.has(id)) return;

  log.info('Requesting spawn PTY', { namespace: 'pty-manager', ptyId: id, shell });
  activeSessions.set(id, { userId, cwd });

  sendToHelper('spawn', { id, cwd, cols, rows, env: process.env, shell });
}

export function writePty(id: string, data: string): void {
  sendToHelper('write', { id, data });
}

export function resizePty(id: string, cols: number, rows: number): void {
  sendToHelper('resize', { id, cols, rows });
}

export function killPty(id: string): void {
  log.info('Requesting kill PTY', { namespace: 'pty-manager', ptyId: id });
  sendToHelper('kill', { id });
  activeSessions.delete(id);
}

// ── Self-register with ShutdownManager ──────────────────────
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
shutdownManager.register('pty-manager', () => killAllPtys(), ShutdownPhase.SERVICES);

export function killAllPtys(): void {
  if (helperProcess) {
    if (process.platform === 'win32' && helperProcess.pid) {
      // On Windows, child.kill() only kills the helper — grandchild shell
      // processes (spawned by node-pty) survive. Use taskkill /T to kill
      // the entire process tree.
      try {
        const r = Bun.spawnSync(['cmd', '/c', `taskkill /F /T /PID ${helperProcess.pid}`]);
        // Fallback: if taskkill fails, try the normal kill
        if (r.exitCode !== 0) helperProcess.kill();
      } catch {
        try {
          helperProcess.kill();
        } catch {}
      }
    } else {
      helperProcess.kill();
    }
    helperProcess = null;
    helperStdin = null;
  }
  activeSessions.clear();
}
