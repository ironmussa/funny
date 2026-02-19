import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { resolve } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import * as schema from './schema.js';

const dbDir = resolve(homedir(), '.funny');
mkdirSync(dbDir, { recursive: true });

const dbPath = resolve(dbDir, 'data.db');
export const sqlite = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA foreign_keys = ON');

// Periodic WAL checkpoint to prevent unbounded WAL growth.
// Runs every 5 minutes; PASSIVE mode never blocks readers/writers.
const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
const walCheckpointTimer = setInterval(() => {
  try {
    sqlite.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } catch (err) {
    console.warn('[db] WAL checkpoint failed:', err);
  }
}, WAL_CHECKPOINT_INTERVAL_MS);
// Don't keep the process alive just for checkpoints
if (walCheckpointTimer.unref) walCheckpointTimer.unref();

/** Flush WAL and close the database cleanly. Call once during shutdown. */
export function closeDatabase() {
  clearInterval(walCheckpointTimer);
  try {
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {}
  try {
    sqlite.close();
    console.log('[db] Database closed');
  } catch (err) {
    console.warn('[db] Error closing database:', err);
  }
}

export const db = drizzle(sqlite, { schema });
export { schema };
