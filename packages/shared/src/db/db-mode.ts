/**
 * Database mode — SQLite only.
 */

export type DbMode = 'sqlite';

/** Always returns 'sqlite'. */
export function getDbMode(): DbMode {
  return 'sqlite';
}
