/**
 * @domain subdomain: Authentication
 * @domain subdomain-type: generic
 * @domain type: value-object
 * @domain layer: domain
 */

import { getDbMode } from '../db/db-mode.js';

export type AuthMode = 'local' | 'multi';

export function resolveAuthMode(value: string | undefined): AuthMode {
  const mode = value?.toLowerCase();
  return mode === 'multi' ? 'multi' : 'local';
}

export function getAuthMode(): AuthMode {
  return resolveAuthMode(process.env.AUTH_MODE);
}

/**
 * Validates that multi-user mode is only used with PostgreSQL.
 * SQLite's single-writer lock makes concurrent multi-user agent writes impractical.
 * Throws at startup if AUTH_MODE=multi without DB_MODE=postgres.
 */
export function validateAuthDbCompat(): void {
  const authMode = getAuthMode();
  const dbMode = getDbMode();
  if (authMode === 'multi' && dbMode !== 'postgres') {
    throw new Error(
      'AUTH_MODE=multi requires DB_MODE=postgres. ' +
        'SQLite does not support concurrent writes needed for multi-user mode.\n' +
        'Set DB_MODE=postgres and DATABASE_URL to use multi-user mode.',
    );
  }
}
