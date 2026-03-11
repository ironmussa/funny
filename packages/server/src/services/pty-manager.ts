/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: WSBroker, ShutdownManager
 *
 * Manages interactive PTY sessions. Selects the best backend at startup:
 *   0. tmux (persistent — sessions survive restarts)
 *   1. Bun native terminal (Linux/macOS — zero dependencies)
 *   2. node-pty via helper process (Windows — requires node-pty package)
 *   3. Null fallback (reports error to client)
 */

import { sqlite } from '../db/index.js';
import { log } from '../lib/logger.js';
import type { PtyBackend } from './pty-backend.js';
import { wsBroker } from './ws-broker.js';

// ── Backend selection ───────────────────────────────────────────────

function selectBackend(): PtyBackend {
  // 0. Try tmux (persistent sessions across restarts)
  if (process.platform !== 'win32') {
    try {
      const { TmuxPtyBackend } =
        require('./pty-backend-tmux.js') as typeof import('./pty-backend-tmux.js');
      const backend = new TmuxPtyBackend();
      if (backend.available) {
        log.info('PTY backend selected: tmux (persistent)', { namespace: 'pty-manager' });
        return backend;
      }
    } catch {
      // tmux not available
    }
  }

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
  projectId?: string;
  label?: string;
  tmuxSession?: string;
  shell?: string;
}

const activeSessions = new Map<string, SessionMeta>();

// ── Scrollback ring buffer (non-persistent backends only) ───────────
// When the backend has no native capturePane (e.g. Bun native), we keep
// a per-session ring buffer of recent output so that reconnecting clients
// can recover visible terminal content.

const MAX_SCROLLBACK_BYTES = 128 * 1024; // 128 KB per session

const scrollbackBuffers = new Map<string, string[]>();
const scrollbackSizes = new Map<string, number>();

function appendScrollback(ptyId: string, data: string): void {
  let chunks = scrollbackBuffers.get(ptyId);
  let size = scrollbackSizes.get(ptyId) ?? 0;
  if (!chunks) {
    chunks = [];
    scrollbackBuffers.set(ptyId, chunks);
  }
  chunks.push(data);
  size += data.length;
  // Evict oldest chunks when over budget
  while (size > MAX_SCROLLBACK_BYTES && chunks.length > 1) {
    size -= chunks.shift()!.length;
  }
  scrollbackSizes.set(ptyId, size);
}

function drainScrollback(ptyId: string): string | null {
  const chunks = scrollbackBuffers.get(ptyId);
  if (!chunks || chunks.length === 0) return null;
  return chunks.join('');
}

function clearScrollback(ptyId: string): void {
  scrollbackBuffers.delete(ptyId);
  scrollbackSizes.delete(ptyId);
}

// ── Wire backend callbacks to WS broker ─────────────────────────────

backend.init({
  onData(ptyId, data) {
    // Buffer output for non-persistent backends so reconnecting clients
    // can recover terminal content via pty:restore
    if (!backend.persistent) {
      appendScrollback(ptyId, data);
    }

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
    clearScrollback(ptyId);
    // Remove from DB if persistent
    if (backend.persistent) {
      removePtySession(ptyId);
    }
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
    clearScrollback(ptyId);
    if (backend.persistent) {
      removePtySession(ptyId);
    }
  },
});

// ── DB helpers for persistent sessions ──────────────────────────────

function savePtySession(
  id: string,
  tmuxSession: string,
  userId: string,
  cwd: string,
  projectId: string | undefined,
  label: string | undefined,
  shell: string | undefined,
  cols: number,
  rows: number,
): void {
  if (!sqlite) return;
  try {
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO pty_sessions (id, tmux_session, user_id, cwd, project_id, label, shell, cols, rows, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        tmuxSession,
        userId,
        cwd,
        projectId ?? null,
        label ?? null,
        shell ?? null,
        cols,
        rows,
        new Date().toISOString(),
      );
  } catch (err: any) {
    log.error('Failed to save PTY session to DB', {
      namespace: 'pty-manager',
      error: err?.message ?? String(err),
    });
  }
}

function removePtySession(id: string): void {
  if (!sqlite) return;
  try {
    sqlite.prepare(`DELETE FROM pty_sessions WHERE id = ?`).run(id);
  } catch (err: any) {
    log.error('Failed to remove PTY session from DB', {
      namespace: 'pty-manager',
      error: err?.message ?? String(err),
    });
  }
}

interface PtySessionRow {
  id: string;
  tmux_session: string;
  user_id: string;
  cwd: string;
  project_id: string | null;
  label: string | null;
  shell: string | null;
  cols: number;
  rows: number;
}

function loadPtySessions(): PtySessionRow[] {
  if (!sqlite) return [];
  try {
    return sqlite.prepare(`SELECT * FROM pty_sessions`).all() as PtySessionRow[];
  } catch (err: any) {
    log.error('Failed to load PTY sessions from DB', {
      namespace: 'pty-manager',
      error: err?.message ?? String(err),
    });
    return [];
  }
}

function loadPtySessionsForUser(userId: string): PtySessionRow[] {
  if (!sqlite) return [];
  try {
    return sqlite
      .prepare(`SELECT * FROM pty_sessions WHERE user_id = ?`)
      .all(userId) as PtySessionRow[];
  } catch (err: any) {
    log.error('Failed to load PTY sessions for user', {
      namespace: 'pty-manager',
      error: err?.message ?? String(err),
    });
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────

export function spawnPty(
  id: string,
  cwd: string,
  cols: number,
  rows: number,
  userId: string,
  shell?: string,
  projectId?: string,
  label?: string,
): void {
  if (activeSessions.has(id)) {
    log.info('PTY already spawned, skipping spawn', { namespace: 'pty-manager', ptyId: id });
    return;
  }

  log.info('Requesting spawn PTY', {
    namespace: 'pty-manager',
    ptyId: id,
    backend: backend.name,
    shell,
    projectId,
    label,
  });

  const tmuxSession = backend.persistent ? `funny-${id}` : undefined;
  activeSessions.set(id, { userId, cwd, projectId, label, tmuxSession, shell });

  backend.spawn(id, cwd, cols, rows, process.env as Record<string, string>, shell);

  // Persist to DB for restart recovery
  if (backend.persistent && tmuxSession) {
    savePtySession(id, tmuxSession, userId, cwd, projectId, label, shell, cols, rows);
  }
}

export function writePty(id: string, data: string): void {
  backend.write(id, data);
}

export function resizePty(id: string, cols: number, rows: number): void {
  backend.resize(id, cols, rows);
}

/**
 * Capture the current visible pane content for a PTY session.
 * For persistent backends (tmux) uses native pane capture.
 * For non-persistent backends, returns the in-memory scrollback buffer.
 */
export function capturePane(id: string): string | null {
  if (backend.capturePane) return backend.capturePane(id);
  // Fallback: return buffered output for non-persistent backends
  return drainScrollback(id);
}

export function killPty(id: string): void {
  log.info('Requesting kill PTY', { namespace: 'pty-manager', ptyId: id });
  backend.kill(id);
  activeSessions.delete(id);
  clearScrollback(id);

  if (backend.persistent) {
    removePtySession(id);
  }
}

export function killAllPtys(): void {
  backend.killAll();
  activeSessions.clear();
  scrollbackBuffers.clear();
  scrollbackSizes.clear();
}

/**
 * List active PTY sessions for a given user.
 * Returns sessions from the DB (for persistent backends) or from in-memory tracking.
 */
export function listActiveSessions(
  userId: string,
): Array<{ ptyId: string; cwd: string; projectId?: string; label?: string; shell?: string }> {
  if (backend.persistent) {
    const rows = loadPtySessionsForUser(userId);
    return rows.map((r) => ({
      ptyId: r.id,
      cwd: r.cwd,
      projectId: r.project_id ?? undefined,
      label: r.label ?? undefined,
      shell: r.shell ?? undefined,
    }));
  }
  // Non-persistent backend: return in-memory sessions
  const result: Array<{
    ptyId: string;
    cwd: string;
    projectId?: string;
    label?: string;
    shell?: string;
  }> = [];
  for (const [id, meta] of activeSessions) {
    if (meta.userId === userId) {
      result.push({
        ptyId: id,
        cwd: meta.cwd,
        projectId: meta.projectId,
        label: meta.label,
        shell: meta.shell,
      });
    }
  }
  return result;
}

/**
 * Reattach to all persisted PTY sessions on server startup.
 * Only works when the tmux backend is active.
 */
export function reattachSessions(): void {
  if (!backend.persistent || !backend.reattach) {
    log.info('PTY backend is not persistent — skipping session reattach', {
      namespace: 'pty-manager',
    });
    return;
  }

  const rows = loadPtySessions();
  if (rows.length === 0) {
    log.info('No PTY sessions to reattach', { namespace: 'pty-manager' });
    return;
  }

  log.info(`Reattaching ${rows.length} PTY session(s)`, { namespace: 'pty-manager' });

  for (const row of rows) {
    activeSessions.set(row.id, {
      userId: row.user_id,
      cwd: row.cwd,
      projectId: row.project_id ?? undefined,
      label: row.label ?? undefined,
      tmuxSession: row.tmux_session,
      shell: row.shell ?? undefined,
    });

    backend.reattach(row.id, row.tmux_session, row.cols, row.rows);
  }
}

/** Whether the active backend supports persistent sessions. */
export const isPersistent = backend.persistent ?? false;

// ── Self-register with ShutdownManager ──────────────────────────────
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';

if (backend.persistent && backend.detachAll) {
  // Persistent backend: detach attach processes but keep tmux sessions alive
  const detachAll = backend.detachAll.bind(backend);
  shutdownManager.register(
    'pty-manager',
    () => {
      detachAll();
      activeSessions.clear();
    },
    ShutdownPhase.SERVICES,
  );
} else {
  // Non-persistent backend: kill everything
  shutdownManager.register('pty-manager', () => killAllPtys(), ShutdownPhase.SERVICES);
}
