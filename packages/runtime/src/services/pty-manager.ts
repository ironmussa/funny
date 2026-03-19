/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: WSBroker, ShutdownManager
 *
 * Manages interactive PTY sessions. Selects the best backend at startup:
 *   0. Daemon (Linux/macOS — PTY processes survive server restarts)
 *   1. Headless xterm.js (Linux/macOS — full state tracking via @xterm/headless)
 *   2. Bun native terminal (Linux/macOS — zero dependencies, fallback)
 *   3. node-pty via helper process (Windows — requires node-pty package)
 *   4. Null fallback (reports error to client)
 */

import { sql } from 'drizzle-orm';

import { db } from '../db/index.js';
import { log } from '../lib/logger.js';
import type { PtyBackend } from './pty-backend.js';
import { wsBroker } from './ws-broker.js';

// ── Backend selection ───────────────────────────────────────────────

function selectBackend(): PtyBackend {
  // 0. Try daemon backend (POSIX only) — preferred because PTY processes
  //    survive server restarts. The daemon runs as a separate Bun process
  //    that owns the PTYs and communicates via Unix socket.
  if (process.platform !== 'win32') {
    try {
      const { DaemonPtyBackend } =
        require('./pty-backend-daemon.js') as typeof import('./pty-backend-daemon.js');
      const backend = new DaemonPtyBackend();
      if (backend.available) {
        log.info('PTY backend selected: daemon', { namespace: 'pty-manager' });
        return backend;
      }
    } catch (err: any) {
      log.warn('Daemon PTY backend failed to load, falling back', {
        namespace: 'pty-manager',
        error: err?.message,
      });
    }
  }

  // 1. Try headless xterm.js backend (POSIX only) — keeps full terminal state
  //    (scrollback, colors, cursor) in memory via @xterm/headless + serialize.
  if (process.platform !== 'win32') {
    try {
      const { HeadlessPtyBackend } =
        require('./pty-backend-headless.js') as typeof import('./pty-backend-headless.js');
      const backend = new HeadlessPtyBackend();
      if (backend.available) {
        log.info('PTY backend selected: headless-xterm', { namespace: 'pty-manager' });
        return backend;
      }
    } catch (err: any) {
      log.warn('Headless xterm backend failed to load, falling back', {
        namespace: 'pty-manager',
        error: err?.message,
      });
    }
  }

  // 1. Try Bun native (POSIX only) — fallback without headless state tracking
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

// ── Persistent session storage (SQLite) ──────────────────────────────
// PTY sessions are persisted to the `pty_sessions` table so the server can
// re-discover them after a full restart (the daemon keeps them alive).

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
  terminal_state: string | null;
}

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
  terminalState?: string | null,
): void {
  try {
    db.run(sql`
      INSERT OR REPLACE INTO pty_sessions (id, tmux_session, user_id, cwd, shell, cols, rows, created_at, project_id, label, terminal_state)
      VALUES (${id}, ${tmuxSession}, ${userId}, ${cwd}, ${shell ?? null}, ${cols}, ${rows}, ${new Date().toISOString()}, ${projectId ?? null}, ${label ?? null}, ${terminalState ?? null})
    `);
  } catch (err: any) {
    log.error('Failed to save PTY session', { namespace: 'pty-manager', id, error: err?.message });
  }
}

function removePtySession(id: string): void {
  try {
    db.run(sql`DELETE FROM pty_sessions WHERE id = ${id}`);
  } catch (err: any) {
    log.error('Failed to remove PTY session', {
      namespace: 'pty-manager',
      id,
      error: err?.message,
    });
  }
}

function loadPtySessions(): PtySessionRow[] {
  return db.all<PtySessionRow>(sql`SELECT * FROM pty_sessions`);
}

function loadPtySessionsForUser(userId: string): PtySessionRow[] {
  return db.all<PtySessionRow>(sql`SELECT * FROM pty_sessions WHERE user_id = ${userId}`);
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
    log.info('PTY already spawned — sending restore instead', {
      namespace: 'pty-manager',
      ptyId: id,
    });
    // The client tried to spawn but the session already exists (e.g. browser refresh).
    // Auto-restore: send the serialized terminal content back to the client.
    // Always emit — even with empty string — so the client exits loading state.
    const session = activeSessions.get(id)!;
    capturePaneAsync(id).then((content) => {
      const event = {
        type: 'pty:data' as const,
        threadId: '',
        data: { ptyId: id, data: content ?? '' },
      };
      if (session.userId && session.userId !== '__local__') {
        wsBroker.emitToUser(session.userId, event);
      } else {
        wsBroker.emit(event);
      }
    });
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

/**
 * Async capture — delegates to the daemon's headless xterm serializer.
 * Falls back to synchronous capturePane for non-daemon backends.
 */
export async function capturePaneAsync(id: string): Promise<string | null> {
  if (backend.name === 'daemon' && 'capturePaneAsync' in backend) {
    const daemonBackend = backend as import('./pty-backend-daemon.js').DaemonPtyBackend;
    return daemonBackend.capturePaneAsync(id);
  }
  return capturePane(id);
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
  // Always include in-memory sessions (running PTYs)
  const result = new Map<
    string,
    { ptyId: string; cwd: string; projectId?: string; label?: string; shell?: string }
  >();

  for (const [id, meta] of activeSessions) {
    if (meta.userId === userId) {
      result.set(id, {
        ptyId: id,
        cwd: meta.cwd,
        projectId: meta.projectId,
        label: meta.label,
        shell: meta.shell,
      });
    }
  }

  // For persistent backends, also include DB sessions (e.g. restored after server restart)
  if (backend.persistent) {
    const rows = loadPtySessionsForUser(userId);
    for (const r of rows) {
      if (!result.has(r.id)) {
        result.set(r.id, {
          ptyId: r.id,
          cwd: r.cwd,
          projectId: r.project_id ?? undefined,
          label: r.label ?? undefined,
          shell: r.shell ?? undefined,
        });
      }
    }
  }

  return Array.from(result.values());
}

/**
 * Reattach to all persisted PTY sessions on server startup.
 * For daemon: queries the daemon for live sessions and syncs with DB metadata.
 * For tmux: reattaches to existing tmux sessions.
 * For headless-xterm: restores serialized terminal state and spawns fresh PTYs.
 */
export async function reattachSessions(): Promise<void> {
  if (!backend.persistent) {
    log.info('PTY backend is not persistent — skipping session reattach', {
      namespace: 'pty-manager',
    });
    return;
  }

  // Daemon backend: query daemon for live sessions, sync with DB metadata
  if (backend.name === 'daemon' && 'listDaemonSessions' in backend) {
    const daemonBackend = backend as import('./pty-backend-daemon.js').DaemonPtyBackend;
    const dbRows = loadPtySessions();
    const dbMap = new Map(dbRows.map((r) => [r.id, r]));

    try {
      const daemonSessions = await daemonBackend.listDaemonSessions();
      log.info(`Daemon reports ${daemonSessions.length} live session(s), DB has ${dbRows.length}`, {
        namespace: 'pty-manager',
      });

      if (daemonSessions.length > 0) {
        for (const ds of daemonSessions) {
          const dbRow = dbMap.get(ds.id);
          activeSessions.set(ds.id, {
            userId: dbRow?.user_id ?? '__local__',
            cwd: ds.cwd,
            projectId: dbRow?.project_id ?? undefined,
            label: dbRow?.label ?? undefined,
            shell: ds.shell,
          });
        }

        // Clean up DB rows for sessions that no longer exist in daemon
        for (const row of dbRows) {
          if (!daemonSessions.find((ds) => ds.id === row.id)) {
            removePtySession(row.id);
          }
        }
      } else if (dbRows.length > 0) {
        // Daemon reports 0 sessions but DB has entries — the daemon has
        // restarted and sessions were lost. Clean up the DB so the client
        // knows the sessions are dead and can spawn new ones.
        log.warn('Daemon has no sessions but DB has entries — sessions lost, cleaning up DB', {
          namespace: 'pty-manager',
          dbCount: dbRows.length,
        });
        for (const row of dbRows) {
          removePtySession(row.id);
        }
      }
    } catch (err: any) {
      log.error('Failed to query daemon for sessions', {
        namespace: 'pty-manager',
        error: err?.message,
      });
      // On failure, still populate from DB so sessions remain visible
      for (const row of dbRows) {
        activeSessions.set(row.id, {
          userId: row.user_id,
          cwd: row.cwd,
          projectId: row.project_id ?? undefined,
          label: row.label ?? undefined,
          shell: row.shell ?? undefined,
        });
      }
    }
    return;
  }

  // Non-daemon persistent backends (tmux, headless-xterm)
  if (!backend.reattach) return;

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

    backend.reattach(
      row.id,
      row.tmux_session,
      row.cols,
      row.rows,
      row.terminal_state ?? undefined,
      row.cwd,
      row.shell ?? undefined,
    );
  }
}

/** Whether the active backend supports persistent sessions. */
export const isPersistent = backend.persistent ?? false;

// ── Self-register with ShutdownManager ──────────────────────────────
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';

if (backend.name === 'daemon' && backend.detachAll) {
  // Daemon backend: just disconnect from socket — daemon keeps PTYs alive.
  // Session metadata stays in DB for the next server instance to discover.
  const detachAll = backend.detachAll.bind(backend);
  shutdownManager.register(
    'pty-manager',
    () => {
      detachAll();
      activeSessions.clear();
      log.info('Disconnected from PTY daemon (sessions preserved)', {
        namespace: 'pty-manager',
      });
    },
    ShutdownPhase.SERVICES,
  );
} else if (backend.persistent && backend.detachAll) {
  // Other persistent backends (headless-xterm, tmux): serialize state then detach
  const detachAll = backend.detachAll.bind(backend);
  shutdownManager.register(
    'pty-manager',
    () => {
      // For headless-xterm: serialize all terminal states to DB before killing
      if ('serializeAll' in backend && typeof (backend as any).serializeAll === 'function') {
        const states = (backend as any).serializeAll() as Map<string, string>;
        for (const [id, state] of states) {
          const meta = activeSessions.get(id);
          if (meta) {
            savePtySession(
              id,
              meta.tmuxSession ?? `headless-${id}`,
              meta.userId,
              meta.cwd,
              meta.projectId,
              meta.label,
              meta.shell,
              80, // cols — will be resized on reconnect
              24, // rows
              state,
            );
          }
        }
        log.info(`Serialized ${states.size} terminal session(s) to DB`, {
          namespace: 'pty-manager',
        });
      }
      detachAll();
      activeSessions.clear();
    },
    ShutdownPhase.SERVICES,
  );
} else {
  // Non-persistent backend: kill everything
  shutdownManager.register('pty-manager', () => killAllPtys(), ShutdownPhase.SERVICES);
}
