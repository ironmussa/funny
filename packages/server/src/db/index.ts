import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { resolve } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import * as schema from './schema.js';

const dbDir = resolve(homedir(), '.funny');
mkdirSync(dbDir, { recursive: true });

const dbPath = resolve(dbDir, 'data.db');
const sqlite = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
export { schema };
