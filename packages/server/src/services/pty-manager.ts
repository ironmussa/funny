/**
 * PtyManager — spawns and manages interactive PTY sessions via a helper Node.js process.
 * This architecture avoids compatibility issues between Bun and node-pty on Windows.
 */

import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { createInterface } from 'readline';
import { wsBroker } from './ws-broker.js';
import { log } from '../lib/abbacchio.js';

let helperProcess: ChildProcess | null = null;
let helperStdin: any = null; // Type as any to avoid strict stream types mismatch
const pendingSpawns = new Set<string>();

// Ensure helper is running
function ensureHelper() {
  if (helperProcess && !helperProcess.killed) return;

  const helperPath = join(import.meta.dir, 'pty-helper.mjs');
  log.info('Spawning PTY helper process', { namespace: 'pty-manager', helperPath });

  helperProcess = spawn('node', [helperPath], {
    stdio: ['pipe', 'pipe', 'inherit'], // Pipe stdin/stdout, inherit stderr for logs
    windowsHide: true,
  });

  helperStdin = helperProcess.stdin;

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
        log.error('Failed to parse PTY helper output', { namespace: 'pty-manager', line, error: err });
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
        log.info('PTY exited', { namespace: 'pty-manager', ptyId: data.ptyId, exitCode: data.exitCode });

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
): void {
  if (activeSessions.has(id)) return;

  log.info('Requesting spawn PTY', { namespace: 'pty-manager', ptyId: id });
  activeSessions.set(id, { userId, cwd });

  sendToHelper('spawn', { id, cwd, cols, rows, env: process.env });
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

export function killAllPtys(): void {
  // If we kill the helper, all children die (usually)
  if (helperProcess) {
    helperProcess.kill();
    helperProcess = null;
    helperStdin = null;
  }
  activeSessions.clear();
}
