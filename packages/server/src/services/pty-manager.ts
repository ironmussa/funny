/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: WSBroker, ShutdownManager
 *
 * Manages interactive PTY sessions. Selects the best backend at startup:
 *   1. Bun native terminal (Linux/macOS — zero dependencies)
 *   2. node-pty via helper process (Windows — requires node-pty package)
 *   3. Null fallback (reports error to client)
 */

import { log } from '../lib/logger.js';
import type { PtyBackend } from './pty-backend.js';
import { wsBroker } from './ws-broker.js';

// ── Backend selection ───────────────────────────────────────────────

function selectBackend(): PtyBackend {
  // 1. Try Bun native (POSIX only)
  if (process.platform !== 'win32') {
    const { BunPtyBackend } =
      require('./pty-backend-bun.js') as typeof import('./pty-backend-bun.js');
    const backend = new BunPtyBackend();
    if (backend.available) {
      log.info('PTY backend selected: bun-native', { namespace: 'pty-manager' });
      return backend;
    }
  }

  // 2. Try node-pty (Windows or POSIX fallback)
  try {
    const { NodePtyBackend } =
      require('./pty-backend-node-pty.js') as typeof import('./pty-backend-node-pty.js');
    const backend = new NodePtyBackend();
    if (backend.available) {
      log.info('PTY backend selected: node-pty', { namespace: 'pty-manager' });
      return backend;
    }
  } catch {
    // node-pty not available
  }

  // 3. Null fallback
  log.warn('No PTY backend available — terminal will not work', { namespace: 'pty-manager' });
  const { NullPtyBackend } =
    require('./pty-backend-null.js') as typeof import('./pty-backend-null.js');
  return new NullPtyBackend();
}

const backend = selectBackend();

// ── Session tracking (for user-scoped WS events) ───────────────────

interface SessionMeta {
  userId: string;
  cwd: string;
}

const activeSessions = new Map<string, SessionMeta>();

// ── Wire backend callbacks to WS broker ─────────────────────────────

backend.init({
  onData(ptyId, data) {
    const session = activeSessions.get(ptyId);
    const event = {
      type: 'pty:data' as const,
      threadId: '',
      data: { ptyId, data },
    };

    if (session?.userId && session.userId !== '__local__') {
      wsBroker.emitToUser(session.userId, event);
    } else {
      wsBroker.emit(event);
    }
  },

  onExit(ptyId, exitCode) {
    const session = activeSessions.get(ptyId);
    log.info('PTY exited', { namespace: 'pty-manager', ptyId, exitCode });

    const event = {
      type: 'pty:exit' as const,
      threadId: '',
      data: { ptyId, exitCode },
    };

    if (session?.userId && session.userId !== '__local__') {
      wsBroker.emitToUser(session.userId, event);
    } else {
      wsBroker.emit(event);
    }

    activeSessions.delete(ptyId);
  },

  onError(ptyId, error) {
    const session = activeSessions.get(ptyId);
    log.error('PTY error', { namespace: 'pty-manager', ptyId, error });

    const event = {
      type: 'pty:error' as const,
      threadId: '',
      data: { ptyId, error },
    };

    if (session?.userId && session.userId !== '__local__') {
      wsBroker.emitToUser(session.userId, event);
    } else {
      wsBroker.emit(event);
    }

    activeSessions.delete(ptyId);
  },
});

// ── Public API (unchanged from previous version) ────────────────────

export function spawnPty(
  id: string,
  cwd: string,
  cols: number,
  rows: number,
  userId: string,
  shell?: string,
): void {
  if (activeSessions.has(id)) return;

  log.info('Requesting spawn PTY', {
    namespace: 'pty-manager',
    ptyId: id,
    backend: backend.name,
    shell,
  });
  activeSessions.set(id, { userId, cwd });

  backend.spawn(id, cwd, cols, rows, process.env as Record<string, string>, shell);
}

export function writePty(id: string, data: string): void {
  backend.write(id, data);
}

export function resizePty(id: string, cols: number, rows: number): void {
  backend.resize(id, cols, rows);
}

export function killPty(id: string): void {
  log.info('Requesting kill PTY', { namespace: 'pty-manager', ptyId: id });
  backend.kill(id);
  activeSessions.delete(id);
}

export function killAllPtys(): void {
  backend.killAll();
  activeSessions.clear();
}

// ── Self-register with ShutdownManager ──────────────────────────────
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
shutdownManager.register('pty-manager', () => killAllPtys(), ShutdownPhase.SERVICES);
