/**
 * PTY session persistence tests — requires bun:sqlite (run via `bun test`).
 *
 * Tests the save/load/remove operations for PTY sessions in SQLite,
 * plus the listActiveSessions merge logic between in-memory and DB sessions.
 */

import { describe, test, expect, beforeEach } from 'bun:test';

import { sql } from 'drizzle-orm';

import { createTestDb } from '../helpers/test-db.js';

// ── Session tracking (same logic as pty-manager.ts) ──────────────────

interface SessionMeta {
  userId: string;
  cwd: string;
  projectId?: string;
  label?: string;
  tmuxSession?: string;
  shell?: string;
}

class SessionTracker {
  private sessions = new Map<string, SessionMeta>();

  set(id: string, meta: SessionMeta): void {
    this.sessions.set(id, meta);
  }

  listForUser(
    userId: string,
  ): Array<{ ptyId: string; cwd: string; projectId?: string; label?: string; shell?: string }> {
    const result: Array<{
      ptyId: string;
      cwd: string;
      projectId?: string;
      label?: string;
      shell?: string;
    }> = [];
    for (const [id, meta] of this.sessions) {
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
}

// ── Persistence helpers (same SQL as pty-manager.ts) ─────────────────

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

function createPtySessionsTable(testDb: ReturnType<typeof createTestDb>) {
  testDb.db.run(sql`
    CREATE TABLE IF NOT EXISTS pty_sessions (
      id TEXT PRIMARY KEY,
      tmux_session TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      shell TEXT,
      cols INTEGER NOT NULL DEFAULT 80,
      rows INTEGER NOT NULL DEFAULT 24,
      created_at TEXT NOT NULL,
      project_id TEXT,
      label TEXT,
      terminal_state TEXT
    )
  `);
}

describe('PTY session persistence (SQLite)', () => {
  let testDb: ReturnType<typeof createTestDb>;

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
    testDb.db.run(sql`
      INSERT OR REPLACE INTO pty_sessions (id, tmux_session, user_id, cwd, shell, cols, rows, created_at, project_id, label, terminal_state)
      VALUES (${id}, ${tmuxSession}, ${userId}, ${cwd}, ${shell ?? null}, ${cols}, ${rows}, ${new Date().toISOString()}, ${projectId ?? null}, ${label ?? null}, ${terminalState ?? null})
    `);
  }

  function removePtySession(id: string): void {
    testDb.db.run(sql`DELETE FROM pty_sessions WHERE id = ${id}`);
  }

  function loadPtySessions(): PtySessionRow[] {
    return testDb.db.all<PtySessionRow>(sql`SELECT * FROM pty_sessions`);
  }

  function loadPtySessionsForUser(userId: string): PtySessionRow[] {
    return testDb.db.all<PtySessionRow>(sql`SELECT * FROM pty_sessions WHERE user_id = ${userId}`);
  }

  beforeEach(() => {
    testDb = createTestDb();
    createPtySessionsTable(testDb);
  });

  test('savePtySession inserts a new row', () => {
    savePtySession(
      'pty-1',
      'funny-pty-1',
      'user-1',
      '/home/user',
      'proj-1',
      'Terminal',
      '/bin/bash',
      80,
      24,
    );

    const rows = loadPtySessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('pty-1');
    expect(rows[0].tmux_session).toBe('funny-pty-1');
    expect(rows[0].user_id).toBe('user-1');
    expect(rows[0].cwd).toBe('/home/user');
    expect(rows[0].project_id).toBe('proj-1');
    expect(rows[0].label).toBe('Terminal');
    expect(rows[0].shell).toBe('/bin/bash');
    expect(rows[0].cols).toBe(80);
    expect(rows[0].rows).toBe(24);
    expect(rows[0].terminal_state).toBeNull();
  });

  test('savePtySession with terminal state', () => {
    const termState = '\\x1b[H\\x1b[2J$ ls\\nfile1.txt\\nfile2.txt';
    savePtySession(
      'pty-1',
      'funny-pty-1',
      'user-1',
      '/home',
      undefined,
      undefined,
      undefined,
      80,
      24,
      termState,
    );

    const rows = loadPtySessions();
    expect(rows[0].terminal_state).toBe(termState);
    expect(rows[0].project_id).toBeNull();
    expect(rows[0].label).toBeNull();
    expect(rows[0].shell).toBeNull();
  });

  test('savePtySession replaces existing row (INSERT OR REPLACE)', () => {
    savePtySession(
      'pty-1',
      'funny-pty-1',
      'user-1',
      '/old/path',
      undefined,
      undefined,
      undefined,
      80,
      24,
    );
    savePtySession(
      'pty-1',
      'funny-pty-1',
      'user-1',
      '/new/path',
      'proj-2',
      'Updated',
      '/bin/zsh',
      120,
      40,
    );

    const rows = loadPtySessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].cwd).toBe('/new/path');
    expect(rows[0].project_id).toBe('proj-2');
    expect(rows[0].label).toBe('Updated');
    expect(rows[0].shell).toBe('/bin/zsh');
    expect(rows[0].cols).toBe(120);
    expect(rows[0].rows).toBe(40);
  });

  test('removePtySession deletes the row', () => {
    savePtySession(
      'pty-1',
      'funny-pty-1',
      'user-1',
      '/home',
      undefined,
      undefined,
      undefined,
      80,
      24,
    );
    savePtySession(
      'pty-2',
      'funny-pty-2',
      'user-1',
      '/work',
      undefined,
      undefined,
      undefined,
      80,
      24,
    );

    removePtySession('pty-1');

    const rows = loadPtySessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('pty-2');
  });

  test('removePtySession on nonexistent is a no-op', () => {
    removePtySession('nonexistent');
    expect(loadPtySessions()).toHaveLength(0);
  });

  test('loadPtySessions returns all sessions', () => {
    savePtySession(
      'pty-1',
      'funny-pty-1',
      'user-1',
      '/home',
      undefined,
      undefined,
      undefined,
      80,
      24,
    );
    savePtySession(
      'pty-2',
      'funny-pty-2',
      'user-2',
      '/work',
      undefined,
      undefined,
      undefined,
      100,
      30,
    );

    const rows = loadPtySessions();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['pty-1', 'pty-2']);
  });

  test('loadPtySessions returns empty when no sessions', () => {
    expect(loadPtySessions()).toEqual([]);
  });

  test('loadPtySessionsForUser filters by userId', () => {
    savePtySession(
      'pty-1',
      'funny-pty-1',
      'user-1',
      '/home/user1',
      'proj-1',
      'Term 1',
      undefined,
      80,
      24,
    );
    savePtySession(
      'pty-2',
      'funny-pty-2',
      'user-2',
      '/home/user2',
      undefined,
      undefined,
      undefined,
      80,
      24,
    );
    savePtySession(
      'pty-3',
      'funny-pty-3',
      'user-1',
      '/home/user1/b',
      'proj-2',
      'Term 2',
      undefined,
      80,
      24,
    );

    const user1Sessions = loadPtySessionsForUser('user-1');
    expect(user1Sessions).toHaveLength(2);
    expect(user1Sessions.map((r) => r.id).sort()).toEqual(['pty-1', 'pty-3']);

    const user2Sessions = loadPtySessionsForUser('user-2');
    expect(user2Sessions).toHaveLength(1);
    expect(user2Sessions[0].id).toBe('pty-2');
  });

  test('loadPtySessionsForUser returns empty for unknown user', () => {
    savePtySession(
      'pty-1',
      'funny-pty-1',
      'user-1',
      '/home',
      undefined,
      undefined,
      undefined,
      80,
      24,
    );
    expect(loadPtySessionsForUser('nonexistent')).toEqual([]);
  });

  test('session lifecycle: save, query, update, remove', () => {
    // 1. Save
    savePtySession(
      'pty-1',
      'funny-pty-1',
      'user-1',
      '/home',
      'proj-1',
      'Terminal',
      '/bin/bash',
      80,
      24,
    );
    expect(loadPtySessions()).toHaveLength(1);

    // 2. Update (terminal state saved on shutdown)
    savePtySession(
      'pty-1',
      'funny-pty-1',
      'user-1',
      '/home',
      'proj-1',
      'Terminal',
      '/bin/bash',
      80,
      24,
      'serialized-state',
    );
    const rows = loadPtySessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].terminal_state).toBe('serialized-state');

    // 3. Query by user
    expect(loadPtySessionsForUser('user-1')).toHaveLength(1);
    expect(loadPtySessionsForUser('user-2')).toHaveLength(0);

    // 4. Remove
    removePtySession('pty-1');
    expect(loadPtySessions()).toHaveLength(0);
  });
});

describe('listActiveSessions with DB merge', () => {
  let tracker: SessionTracker;
  let testDb: ReturnType<typeof createTestDb>;

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
    testDb.db.run(sql`
      INSERT OR REPLACE INTO pty_sessions (id, tmux_session, user_id, cwd, shell, cols, rows, created_at, project_id, label)
      VALUES (${id}, ${tmuxSession}, ${userId}, ${cwd}, ${shell ?? null}, ${cols}, ${rows}, ${new Date().toISOString()}, ${projectId ?? null}, ${label ?? null})
    `);
  }

  function loadPtySessionsForUser(userId: string): PtySessionRow[] {
    return testDb.db.all<PtySessionRow>(sql`SELECT * FROM pty_sessions WHERE user_id = ${userId}`);
  }

  /**
   * Simulate listActiveSessions for a persistent backend:
   * merges in-memory sessions with DB sessions (DB sessions may exist after restart).
   */
  function listActiveSessions(
    userId: string,
    persistent: boolean,
  ): Array<{ ptyId: string; cwd: string; projectId?: string; label?: string; shell?: string }> {
    const result = new Map<
      string,
      { ptyId: string; cwd: string; projectId?: string; label?: string; shell?: string }
    >();

    // In-memory sessions
    for (const session of tracker.listForUser(userId)) {
      result.set(session.ptyId, session);
    }

    // For persistent backends, also include DB sessions
    if (persistent) {
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

  beforeEach(() => {
    tracker = new SessionTracker();
    testDb = createTestDb();
    createPtySessionsTable(testDb);
  });

  test('non-persistent backend: only returns in-memory sessions', () => {
    tracker.set('pty-1', { userId: 'user-1', cwd: '/home' });
    savePtySession(
      'pty-db-1',
      'funny-pty-db-1',
      'user-1',
      '/db-home',
      undefined,
      undefined,
      undefined,
      80,
      24,
    );

    const sessions = listActiveSessions('user-1', false);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ptyId).toBe('pty-1');
  });

  test('persistent backend: merges in-memory and DB sessions', () => {
    tracker.set('pty-1', { userId: 'user-1', cwd: '/home' });
    savePtySession(
      'pty-db-1',
      'funny-pty-db-1',
      'user-1',
      '/db-home',
      'proj-1',
      'DB Term',
      '/bin/zsh',
      80,
      24,
    );

    const sessions = listActiveSessions('user-1', true);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.ptyId).sort()).toEqual(['pty-1', 'pty-db-1']);
  });

  test('persistent backend: in-memory takes priority over DB for same ptyId', () => {
    tracker.set('pty-1', {
      userId: 'user-1',
      cwd: '/memory-path',
      label: 'Memory Label',
    });
    savePtySession(
      'pty-1',
      'funny-pty-1',
      'user-1',
      '/db-path',
      undefined,
      'DB Label',
      undefined,
      80,
      24,
    );

    const sessions = listActiveSessions('user-1', true);
    expect(sessions).toHaveLength(1);
    // In-memory wins
    expect(sessions[0].cwd).toBe('/memory-path');
    expect(sessions[0].label).toBe('Memory Label');
  });

  test('persistent backend: filters DB sessions by userId too', () => {
    savePtySession(
      'pty-1',
      'funny-pty-1',
      'user-1',
      '/home1',
      undefined,
      undefined,
      undefined,
      80,
      24,
    );
    savePtySession(
      'pty-2',
      'funny-pty-2',
      'user-2',
      '/home2',
      undefined,
      undefined,
      undefined,
      80,
      24,
    );

    const sessions = listActiveSessions('user-1', true);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ptyId).toBe('pty-1');
  });
});
