/**
 * `bun run db:migrate` applies the server migrations without starting the
 * server, is idempotent, and exits non-zero when the database is unreachable.
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../hosts/bun/migrate-cli.ts');

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'funny-migrate-'));
});

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

function runCli(env: Record<string, string>) {
  const { DATABASE_URL: _ignored, ...base } = process.env;
  return Bun.spawnSync(['bun', CLI], {
    env: { ...base, FUNNY_DATA_DIR: dataDir, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function appliedMigrations(): number {
  const sqlite = new Database(join(dataDir, 'data.db'), { readonly: true });
  try {
    return (sqlite.query('SELECT COUNT(*) AS c FROM _migrations').get() as { c: number }).c;
  } finally {
    sqlite.close();
  }
}

describe('db:migrate', () => {
  test('applies the migrations to a fresh SQLite database and exits 0', () => {
    const result = runCli({});
    expect(result.exitCode).toBe(0);
    expect(appliedMigrations()).toBeGreaterThan(0);
  });

  test('is idempotent', () => {
    const before = appliedMigrations();
    expect(runCli({}).exitCode).toBe(0);
    expect(appliedMigrations()).toBe(before);
  });

  test('exits 1 when the database is unreachable', () => {
    const result = runCli({ DATABASE_URL: 'postgres://127.0.0.1:1/unreachable' });
    expect(result.exitCode).toBe(1);
  });
});
