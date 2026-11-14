/**
 * The run store on SQLite (`bun:sqlite`), one file in the factory home.
 * Tables are created on open, and columns added since are added to an older
 * file (`ALTER TABLE … ADD COLUMN`).
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

import type { FactoryRun, RunStore } from '../ports/run-store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  state TEXT NOT NULL,
  pr_url TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Later columns are in LATER_COLUMNS.
CREATE TABLE IF NOT EXISTS daily_starts (
  day TEXT PRIMARY KEY,
  started INTEGER NOT NULL DEFAULT 0
);
`;

/** Columns added after the first version of the table. */
const LATER_COLUMNS: Array<[string, string]> = [
  ['issue_title', 'TEXT'],
  ['branch', 'TEXT'],
  ['base', 'TEXT'],
  ['session_id', 'TEXT'],
  ['fix_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['next_check_at', 'TEXT'],
  ['pushed_at', 'TEXT'],
];

interface RunRow {
  id: string;
  repo: string;
  issue_number: number;
  state: string;
  pr_url: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
  issue_title: string | null;
  branch: string | null;
  base: string | null;
  session_id: string | null;
  fix_attempts: number;
  next_check_at: string | null;
  pushed_at: string | null;
}

const toRun = (row: RunRow): FactoryRun => ({
  id: row.id,
  repo: row.repo,
  issueNumber: row.issue_number,
  state: row.state,
  prUrl: row.pr_url,
  reason: row.reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  issueTitle: row.issue_title ?? undefined,
  branch: row.branch ?? undefined,
  base: row.base ?? undefined,
  sessionId: row.session_id ?? undefined,
  fixAttempts: row.fix_attempts,
  nextCheckAt: row.next_check_at ?? undefined,
  pushedAt: row.pushed_at ?? undefined,
});

export function openRunStore(path: string): RunStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const present = new Set(
    db
      .query<{ name: string }, []>('PRAGMA table_info(runs)')
      .all()
      .map((c) => c.name),
  );
  for (const [name, type] of LATER_COLUMNS) {
    if (!present.has(name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
  }
  const listQuery = db.query<RunRow, []>('SELECT * FROM runs ORDER BY created_at DESC, id DESC');
  const saveQuery = db.query(
    `INSERT OR REPLACE INTO runs (id, repo, issue_number, state, pr_url, reason, created_at, updated_at,
       issue_title, branch, base, session_id, fix_attempts, next_check_at, pushed_at)
     VALUES ($id, $repo, $issueNumber, $state, $prUrl, $reason, $createdAt, $updatedAt,
       $issueTitle, $branch, $base, $sessionId, $fixAttempts, $nextCheckAt, $pushedAt)`,
  );
  const startedQuery = db.query<{ started: number }, [string]>(
    'SELECT started FROM daily_starts WHERE day = ?',
  );
  const recordStartQuery = db.query<unknown, [string]>(
    'INSERT INTO daily_starts (day, started) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET started = started + 1',
  );
  return {
    list: () => listQuery.all().map(toRun),
    recordStart: (day) => void recordStartQuery.run(day),
    save: (run) =>
      void saveQuery.run({
        ...run,
        issueTitle: run.issueTitle ?? null,
        branch: run.branch ?? null,
        base: run.base ?? null,
        sessionId: run.sessionId ?? null,
        fixAttempts: run.fixAttempts ?? 0,
        nextCheckAt: run.nextCheckAt ?? null,
        pushedAt: run.pushedAt ?? null,
      }),
    startedOn: (day) => startedQuery.get(day)?.started ?? 0,
    close: () => db.close(),
  };
}
