/**
 * Database dialect detection and connection URL resolution.
 *
 * Resolves the active dialect from environment variables:
 *   1. `DB_MODE` (explicit: "sqlite", "postgres", "postgresql", "pg") → maps to DbDialect
 *   2. `AUTH_MODE=multi` → infers 'pg'
 *   3. `DATABASE_URL` present → 'pg'
 *   4. Default → 'sqlite'
 */

import type { DbDialect } from './provider.js';

/** @deprecated Use DbDialect from provider.ts instead. */
export type DbMode = DbDialect;

/**
 * Detect the database dialect from environment variables.
 *
 * Priority: DB_MODE > AUTH_MODE > DATABASE_URL > default ('sqlite').
 */
export function getDbMode(): DbDialect {
  const raw = process.env.DB_MODE?.trim().toLowerCase();

  if (raw) {
    if (raw === 'postgres' || raw === 'postgresql' || raw === 'pg') return 'pg';
    if (raw === 'sqlite') return 'sqlite';
    // Unknown value — fall through to other heuristics
  }

  // AUTH_MODE=multi implies a multi-user deployment which needs PostgreSQL
  if (process.env.AUTH_MODE?.trim().toLowerCase() === 'multi') return 'pg';

  // DATABASE_URL present implies PostgreSQL
  if (process.env.DATABASE_URL) return 'pg';

  return 'sqlite';
}

/**
 * Resolve the PostgreSQL connection URL from environment variables.
 *
 * Priority:
 *   1. `DATABASE_URL` — used as-is
 *   2. `DB_HOST` + `DB_USER` (+ optional `DB_PASSWORD`, `DB_PORT`, `DB_NAME`) — builds URL
 *   3. Returns `null` if not enough info is available
 */
export function getDatabaseUrl(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const host = process.env.DB_HOST?.trim();
  const user = process.env.DB_USER?.trim();

  if (!host || !user) return null;

  const port = process.env.DB_PORT?.trim() || '5432';
  const dbName = process.env.DB_NAME?.trim() || 'funny';
  const password = process.env.DB_PASSWORD;

  const credentials = password ? `${user}:${encodeURIComponent(password)}` : user;

  return `postgresql://${credentials}@${host}:${port}/${dbName}`;
}
