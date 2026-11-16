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
CREATE TABLE IF NOT EXISTS repo_notices (
  repo TEXT PRIMARY KEY,
  notice TEXT NOT NULL
);
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
  ['infra_retries', 'INTEGER NOT NULL DEFAULT 0'],
  ['not_before', 'TEXT'],
  ['handed_back_at', 'TEXT'],
  ['claimed_at', 'TEXT'],
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
  infra_retries: number;
  not_before: string | null;
  handed_back_at: string | null;
  claimed_at: string | null;
}

/** Fields a run may not have yet, stored as NULL (counters as 0). */
const OPTIONAL_TEXT = [
  'issueTitle',
  'branch',
  'base',
  'sessionId',
  'nextCheckAt',
  'pushedAt',
  'notBefore',
  'handedBackAt',
  'claimedAt',
] as const;

/** The column of each optional text field. */
const OPTIONAL_COLUMNS: Record<(typeof OPTIONAL_TEXT)[number], keyof RunRow> = {
  issueTitle: 'issue_title',
  branch: 'branch',
  base: 'base',
  sessionId: 'session_id',
  nextCheckAt: 'next_check_at',
  pushedAt: 'pushed_at',
  notBefore: 'not_before',
  handedBackAt: 'handed_back_at',
  claimedAt: 'claimed_at',
};

function toRun(row: RunRow): FactoryRun {
  const run: FactoryRun = {
    id: row.id,
    repo: row.repo,
    issueNumber: row.issue_number,
    state: row.state,
    prUrl: row.pr_url,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fixAttempts: row.fix_attempts,
    infraRetries: row.infra_retries,
  };
  for (const key of OPTIONAL_TEXT) {
    const value = row[OPTIONAL_COLUMNS[key]];
    if (typeof value === 'string') run[key] = value;
  }
  return run;
}

function toParams(run: FactoryRun): Record<string, string | number | null> {
  const params: Record<string, string | number | null> = {
    id: run.id,
    repo: run.repo,
    issueNumber: run.issueNumber,
    state: run.state,
    prUrl: run.prUrl,
    reason: run.reason,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    fixAttempts: run.fixAttempts ?? 0,
    infraRetries: run.infraRetries ?? 0,
  };
  for (const key of OPTIONAL_TEXT) params[key] = run[key] ?? null;
  return params;
}

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
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
    // Runs that failed before hand-backs existed are not handed back now.
    if (name === 'handed_back_at') {
      db.exec("UPDATE runs SET handed_back_at = updated_at WHERE state = 'failed'");
    }
  }
  const listQuery = db.query<RunRow, []>('SELECT * FROM runs ORDER BY created_at DESC, id DESC');
  const saveQuery = db.query(
    `INSERT OR REPLACE INTO runs (id, repo, issue_number, state, pr_url, reason, created_at, updated_at,
       issue_title, branch, base, session_id, fix_attempts, next_check_at, pushed_at,
       infra_retries, not_before, handed_back_at, claimed_at)
     VALUES ($id, $repo, $issueNumber, $state, $prUrl, $reason, $createdAt, $updatedAt,
       $issueTitle, $branch, $base, $sessionId, $fixAttempts, $nextCheckAt, $pushedAt,
       $infraRetries, $notBefore, $handedBackAt, $claimedAt)`,
  );
  const startedQuery = db.query<{ started: number }, [string]>(
    'SELECT started FROM daily_starts WHERE day = ?',
  );
  const recordStartQuery = db.query<unknown, [string]>(
    'INSERT INTO daily_starts (day, started) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET started = started + 1',
  );
  const setNotice = db.query<unknown, [string, string]>(
    'INSERT OR REPLACE INTO repo_notices (repo, notice) VALUES (?, ?)',
  );
  const clearNotice = db.query<unknown, [string]>('DELETE FROM repo_notices WHERE repo = ?');
  const notices = db.query<{ repo: string; notice: string }, []>(
    'SELECT repo, notice FROM repo_notices ORDER BY repo',
  );
  return {
    list: () => listQuery.all().map(toRun),
    setRepoNotice: (repo, notice) =>
      void (notice === null ? clearNotice.run(repo) : setNotice.run(repo, notice)),
    repoNotices: () => notices.all(),
    recordStart: (day) => void recordStartQuery.run(day),
    save: (run) => void saveQuery.run(toParams(run)),
    startedOn: (day) => startedQuery.get(day)?.started ?? 0,
    close: () => db.close(),
  };
}
