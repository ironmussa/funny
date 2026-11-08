import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createSqliteProvider } from '../db/adapters/sqlite.js';

describe('createSqliteProvider pragmas', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test('uses WAL with synchronous=NORMAL, a 64 MiB cache and in-memory temp storage', async () => {
    dir = mkdtempSync(join(tmpdir(), 'funny-sqlite-pragmas-'));
    const provider = createSqliteProvider({ path: join(dir, 'data.db') });
    const raw = provider.rawDriver as import('bun:sqlite').Database;
    const pragma = (name: string) =>
      Object.values(raw.query(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
    try {
      expect(pragma('journal_mode')).toBe('wal');
      expect(pragma('synchronous')).toBe(1); // NORMAL
      expect(pragma('cache_size')).toBe(-65536);
      expect(pragma('temp_store')).toBe(2); // MEMORY
      expect(pragma('foreign_keys')).toBe(1);
    } finally {
      await provider.close();
    }
  });
});
