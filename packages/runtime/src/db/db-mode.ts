/**
 * @domain subdomain: Shared Kernel
 * @domain type: value-object
 * @domain layer: domain
 */

export type DbMode = 'sqlite' | 'postgres';

/**
 * Returns the database mode based on the `DB_MODE` environment variable.
 *
 * Inference rules:
 *   1. Explicit `DB_MODE` takes priority
 *   2. `AUTH_MODE=multi` → infer `postgres`
 *   3. Default → `sqlite`
 */
export function getDbMode(): DbMode {
  const raw = process.env.DB_MODE?.toLowerCase();
  if (raw === 'postgres' || raw === 'postgresql') return 'postgres';
  if (raw === 'sqlite') return 'sqlite';

  // Auto-infer: multi-user mode requires PostgreSQL
  if (process.env.AUTH_MODE?.toLowerCase() === 'multi') return 'postgres';

  return 'sqlite';
}

/**
 * Builds a PostgreSQL connection URL from environment variables.
 *
 * Supports two styles:
 *   1. `DATABASE_URL` — a full connection string (takes priority)
 *   2. Individual variables: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
 *
 * Returns `null` if neither style provides enough info.
 */
export function getDatabaseUrl(): string | null {
  // Full URL takes priority
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  // Build from individual env vars
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  if (!host || !user) return null;

  const port = process.env.DB_PORT || '5432';
  const password = process.env.DB_PASSWORD;
  const dbName = process.env.DB_NAME || 'funny';

  const userInfo = password ? `${user}:${encodeURIComponent(password)}` : user;
  return `postgresql://${userInfo}@${host}:${port}/${dbName}`;
}
