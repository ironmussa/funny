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

import { basename } from 'path';

import { detectEnv } from '@funny/core';
import { sql } from 'drizzle-orm';

import { db, getConnection } from '../db/index.js';
import { log } from '../lib/logger.js';
import { metric, recordHistogram } from '../lib/telemetry.js';
import type { PtyBackend } from './pty-backend.js';
import { validateShellId } from './shell-detector.js';
import { wsBroker } from './ws-broker.js';

/** In runner mode there is no local DB — one user per runner. */
const isRunnerMode = !!process.env.TEAM_SERVER_URL;

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

// ── PTY → WS output coalescing ───────────────────────────────────────
// High-throughput shell output (e.g. `cat large`, `yes`, npm install) hits
// the onData callback once per PTY read syscall — typically every few KB.
// Each callback previously produced one full JSON-serialized WS frame, which
// is the dominant CPU cost on the runtime under load. We coalesce contiguous
// chunks into a single pty:data event:
//   - flush when the buffered output reaches FLUSH_BYTES
//   - otherwise flush after FLUSH_MS via a single timer
//   - flush on session close (exit/error/kill) so no bytes are lost
//
// FLUSH_MS is intentionally small (≈120 Hz) so interactive echo latency
// stays imperceptible while still aggregating during bursts.

const FLUSH_BYTES = Number(process.env.PTY_FLUSH_BYTES) || 64 * 1024;
const FLUSH_MS = Number(process.env.PTY_FLUSH_MS) || 8;

interface CoalesceBuffer {
  chunks: string[];
  bytes: number;
  chunkCount: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const coalesceBuffers = new Map<string, CoalesceBuffer>();

function flushCoalesce(ptyId: string, reason: 'size' | 'timer' | 'close'): void {
  const buf = coalesceBuffers.get(ptyId);
  if (!buf || buf.chunks.length === 0) return;
  if (buf.timer) {
    clearTimeout(buf.timer);
    buf.timer = null;
  }
  const joined = buf.chunks.length === 1 ? buf.chunks[0] : buf.chunks.join('');
  const chunkCount = buf.chunkCount;
  // Free the empty buffer — a fresh chunk will recreate it on demand.
  coalesceBuffers.delete(ptyId);

  const session = activeSessions.get(ptyId);
  if (!session?.userId) {
    // Session was already torn down — drop silently. Counters still recorded.
    metric('pty.flush', 1, { attributes: { reason, dropped: 'true' } });
    return;
  }

  // Convert to a UTF-8 byte buffer so Socket.IO emits a binary frame
  // (rather than JSON-escaping each byte). This is the biggest win for
  // heavy stdout: no per-byte escape, no JSON.parse on the receiver.
  const payload = Buffer.from(joined, 'utf8');

  wsBroker.emitToUser(session.userId, {
    type: 'pty:data' as const,
    threadId: '',
    data: { ptyId, data: payload },
  });

  metric('pty.flush', 1, { attributes: { reason } });
  recordHistogram('pty.flush_chunks', chunkCount);
  recordHistogram('pty.flush_bytes', payload.byteLength, { unit: 'By' });
}

function enqueueCoalesce(ptyId: string, data: string): void {
  let buf = coalesceBuffers.get(ptyId);
  if (!buf) {
    buf = { chunks: [], bytes: 0, chunkCount: 0, timer: null };
    coalesceBuffers.set(ptyId, buf);
  }
  buf.chunks.push(data);
  buf.bytes += data.length;
  buf.chunkCount += 1;

  if (buf.bytes >= FLUSH_BYTES) {
    flushCoalesce(ptyId, 'size');
    return;
  }
  if (!buf.timer) {
    buf.timer = setTimeout(() => flushCoalesce(ptyId, 'timer'), FLUSH_MS);
  }
}

function dropCoalesce(ptyId: string): void {
  const buf = coalesceBuffers.get(ptyId);
  if (!buf) return;
  if (buf.timer) clearTimeout(buf.timer);
  coalesceBuffers.delete(ptyId);
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
    if (!session?.userId) {
      log.warn('PTY data for session without userId — dropping', {
        namespace: 'pty-manager',
        ptyId,
      });
      return;
    }
    enqueueCoalesce(ptyId, data);
  },

  onExit(ptyId, exitCode) {
    // Flush any pending output so the client renders the final bytes
    // BEFORE seeing the exit event.
    flushCoalesce(ptyId, 'close');
    dropCoalesce(ptyId);

    const session = activeSessions.get(ptyId);
    log.info('PTY exited', { namespace: 'pty-manager', ptyId, exitCode });

    if (!session?.userId) {
      log.warn('PTY exit for session without userId — dropping', {
        namespace: 'pty-manager',
        ptyId,
      });
    } else {
      wsBroker.emitToUser(session.userId, {
        type: 'pty:exit' as const,
        threadId: '',
        data: { ptyId, exitCode },
      });
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

    // The daemon already has this session alive. Adopt it instead of
    // surfacing the error — happens when the runtime's activeSessions map
    // fell out of sync (e.g. runtime restart, strict-mode remount, or a
    // stale daemon on disk). Keep the session, send a capture back so the
    // client renders the live terminal state.
    if (error === 'Session already exists' && session?.userId) {
      log.info('PTY spawn adopted existing daemon session', {
        namespace: 'pty-manager',
        ptyId,
      });
      void capturePaneAsync(ptyId).then((content) => {
        wsBroker.emitToUser(session.userId, {
          type: 'pty:data' as const,
          threadId: '',
          data: { ptyId, data: content ?? '' },
        });
      });
      return;
    }

    log.error('PTY error', { namespace: 'pty-manager', ptyId, error });

    // Flush any buffered output before the error event so we never lose
    // the last bytes the PTY managed to produce.
    flushCoalesce(ptyId, 'close');
    dropCoalesce(ptyId);

    if (!session?.userId) {
      log.warn('PTY error for session without userId — dropping', {
        namespace: 'pty-manager',
        ptyId,
      });
    } else {
      wsBroker.emitToUser(session.userId, {
        type: 'pty:error' as const,
        threadId: '',
        data: { ptyId, error },
      });
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
  if (!getConnection()) return; // No DB in runner mode
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
  if (!getConnection()) return; // No DB in runner mode
  try {
    db.run(sql`Delete FROM pty_sessions WHERE id = ${id}`);
  } catch (err: any) {
    log.error('Failed to remove PTY session', {
      namespace: 'pty-manager',
      id,
      error: err?.message,
    });
  }
}

function loadPtySessions(): PtySessionRow[] {
  if (!getConnection()) return []; // No DB in runner mode
  return db.all<PtySessionRow>(sql`SELECT * FROM pty_sessions`);
}

function loadPtySessionsForUser(userId: string): PtySessionRow[] {
  if (!getConnection()) return []; // No DB in runner mode
  return db.all<PtySessionRow>(sql`SELECT * FROM pty_sessions WHERE user_id = ${userId}`);
}

// ── Venv activation ──────────────────────────────────────────────────
// detectEnv() prepends the venv's bin to PATH so binaries resolve, but the
// shell prompt only shows `(.venv)` if the shell-specific `activate` script
// is sourced (it's what mutates PS1). We inject the source command into the
// fresh PTY so the user sees the same prompt cosmetics as a manual activation.

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveShellName(safeShell: string | undefined): string {
  if (safeShell && safeShell !== 'default') return safeShell;
  const sysShell = process.env.SHELL;
  return sysShell ? basename(sysShell) : 'sh';
}

function buildVenvActivateCommand(venvPath: string, safeShell: string | undefined): string | null {
  const shellName = resolveShellName(safeShell);
  const quoted = shellSingleQuote(venvPath);
  switch (shellName) {
    case 'fish':
      return `source ${quoted}/bin/activate.fish && clear\r`;
    case 'csh':
    case 'tcsh':
      return `source ${quoted}/bin/activate.csh && clear\r`;
    case 'nu':
    case 'nushell':
    case 'powershell':
    case 'pwsh':
    case 'cmd':
      return null;
    default:
      return `source ${quoted}/bin/activate && clear\r`;
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
    log.info('PTY already spawned — sending restore instead', {
      namespace: 'pty-manager',
      ptyId: id,
    });
    // The client tried to spawn but the session already exists (e.g. browser refresh).
    // Auto-restore: send the serialized terminal content back to the client.
    // Always emit — even with empty string — so the client exits loading state.
    const session = activeSessions.get(id)!;
    void capturePaneAsync(id).then((content) => {
      if (!session.userId) {
        log.warn('PTY restore for session without userId — dropping', {
          namespace: 'pty-manager',
          ptyId: id,
        });
        return;
      }
      wsBroker.emitToUser(session.userId, {
        type: 'pty:data' as const,
        threadId: '',
        data: { ptyId: id, data: content ?? '' },
      });
    });
    return;
  }

  // Reject arbitrary executables in the shell arg — only accept 'default',
  // undefined, or an id from the detected-shells allowlist. Unknown ids are
  // coerced to 'default' (system shell) so a malicious client can't run an
  // attacker-supplied binary.
  const safeShell = validateShellId(shell);

  log.info('Requesting spawn PTY', {
    namespace: 'pty-manager',
    ptyId: id,
    backend: backend.name,
    shell: safeShell,
    projectId,
    label,
  });

  const tmuxSession = backend.persistent ? `funny-${id}` : undefined;
  activeSessions.set(id, { userId, cwd, projectId, label, tmuxSession, shell: safeShell });

  const spawnEnv: Record<string, string | undefined> = { ...process.env };
  const detected = detectEnv(cwd, spawnEnv);
  if (detected.notes.length > 0) {
    Object.assign(spawnEnv, detected.env);
    log.info('Activating per-directory env for PTY', {
      namespace: 'pty-manager',
      ptyId: id,
      activations: detected.notes,
    });
    wsBroker.emitToUser(userId, {
      type: 'pty:env_activated' as const,
      threadId: '',
      data: { ptyId: id, activations: detected.notes },
    });
  }

  backend.spawn(id, cwd, cols, rows, spawnEnv as Record<string, string>, safeShell);

  // Source the venv activate script so the prompt picks up the (.venv) marker.
  // detectEnv() already set VIRTUAL_ENV/PATH; the activate script just adds the
  // PS1 mutation that bash/zsh need to render the prefix.
  const venvNote = detected.notes.find((n) => n.kind === 'python-venv');
  if (venvNote && process.platform !== 'win32') {
    const activateCmd = buildVenvActivateCommand(venvNote.detail, safeShell);
    if (activateCmd) {
      // Small delay so the shell finishes printing its initial prompt before
      // our command lands — without this the source line interleaves with the
      // prompt draw and `clear` may run before .bashrc finishes.
      setTimeout(() => {
        try {
          backend.write(id, activateCmd);
        } catch (err: any) {
          log.warn('Failed to write venv activation to PTY', {
            namespace: 'pty-manager',
            ptyId: id,
            error: err?.message,
          });
        }
      }, 150);
    }
  }

  // Persist to DB for restart recovery
  if (backend.persistent && tmuxSession) {
    savePtySession(id, tmuxSession, userId, cwd, projectId, label, safeShell, cols, rows);
  }
}

/**
 * Security CR-2: ownership lookup used by `pty-message-handler.ts` to reject
 * write / resize / kill / signal / restore operations against sessions that
 * don't belong to the requesting user.
 *
 * In runner mode, sessions reattached after a process restart may not have a
 * `userId` until a request adopts them. Mirror the policy from
 * `listActiveSessions`: in runner mode (one user per runner) adopt the first
 * requesting userId; in non-runner mode the answer is strict.
 *
 * Returns:
 *  - "owner"      → session exists and belongs to `userId`
 *  - "unowned"    → session exists with no userId yet (caller decides
 *                   whether adoption is allowed for this op)
 *  - "denied"     → session exists but belongs to a different user
 *  - "not_found"  → no such session
 */
export type PtyOwnership = 'owner' | 'unowned' | 'denied' | 'not_found';

export function checkSessionOwnership(ptyId: string, userId: string): PtyOwnership {
  const session = activeSessions.get(ptyId);
  if (!session) return 'not_found';
  if (!session.userId) return 'unowned';
  return session.userId === userId ? 'owner' : 'denied';
}

/**
 * Adopt an unowned session into the caller's name. Only safe in runner mode
 * (one user per runner) — `pty-message-handler.ts` gates the call.
 */
export function adoptSession(ptyId: string, userId: string): void {
  const session = activeSessions.get(ptyId);
  if (session && !session.userId) session.userId = userId;
}

/**
 * Single decision point for "may this user act on this PTY session?".
 *
 * - In runner mode: adopt unowned sessions (the previous behaviour for
 *   reattached daemons), then enforce strict ownership.
 * - In server-attached mode: never adopt — every session must have a
 *   recorded owner or the op is rejected.
 *
 * Returns true when the op should proceed.
 */
export function assertSessionAccess(ptyId: string, userId: string): boolean {
  const status = checkSessionOwnership(ptyId, userId);
  if (status === 'owner') return true;
  if (status === 'unowned' && isRunnerMode) {
    adoptSession(ptyId, userId);
    return true;
  }
  return false;
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

export function signalPty(id: string, signal: number): void {
  if (backend.signal) {
    backend.signal(id, signal);
  } else {
    log.warn('Signal not supported by PTY backend', {
      namespace: 'pty-manager',
      ptyId: id,
      signal,
      backend: backend.name,
    });
  }
}

export function killPty(id: string): void {
  log.info('Requesting kill PTY', { namespace: 'pty-manager', ptyId: id });
  // Flush buffered output before tearing down so the client receives
  // whatever the PTY had emitted just before the kill request.
  flushCoalesce(id, 'close');
  dropCoalesce(id);
  backend.kill(id);
  activeSessions.delete(id);
  clearScrollback(id);

  if (backend.persistent) {
    removePtySession(id);
  }
}

export function killAllPtys(): void {
  // Snapshot the keys: flushCoalesce mutates coalesceBuffers as it drains.
  for (const ptyId of [...coalesceBuffers.keys()]) {
    flushCoalesce(ptyId, 'close');
  }
  // Any entries still present had no pending data — clear pending timers
  // (none expected, but be defensive).
  for (const buf of coalesceBuffers.values()) {
    if (buf.timer) clearTimeout(buf.timer);
  }
  coalesceBuffers.clear();
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
    // In runner mode, reattached sessions lose their userId (no DB to store it).
    // Since there's only one user per runner, adopt the first requesting userId.
    if (isRunnerMode && !meta.userId) {
      meta.userId = userId;
    }
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
            userId: dbRow?.user_id ?? '',
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
