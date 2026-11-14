/**
 * The run store on SQLite (`bun:sqlite`), one file in the factory home.
 * Tables are created on open; no migrations yet.
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
CREATE TABLE IF NOT EXISTS daily_starts (
  day TEXT PRIMARY KEY,
  started INTEGER NOT NULL DEFAULT 0
);
`;

interface RunRow {
  id: string;
  repo: string;
  issue_number: number;
  state: string;
  pr_url: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
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
});

export function openRunStore(path: string): RunStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const listQuery = db.query<RunRow, []>('SELECT * FROM runs ORDER BY created_at DESC, id DESC');
  const saveQuery = db.query(
    `INSERT OR REPLACE INTO runs (id, repo, issue_number, state, pr_url, reason, created_at, updated_at)
     VALUES ($id, $repo, $issueNumber, $state, $prUrl, $reason, $createdAt, $updatedAt)`,
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
    save: (run) => void saveQuery.run({ ...run }),
    startedOn: (day) => startedQuery.get(day)?.started ?? 0,
    close: () => db.close(),
  };
}
