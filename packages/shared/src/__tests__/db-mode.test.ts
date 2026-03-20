import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import { getDbMode, getDatabaseUrl } from '../db/db-mode.js';

// ── Env var helpers ──────────────────────────────────────────────

const ENV_KEYS = [
  'DB_MODE',
  'AUTH_MODE',
  'DATABASE_URL',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ── getDbMode ────────────────────────────────────────────────────

describe('getDbMode', () => {
  test('returns sqlite by default', () => {
    expect(getDbMode()).toBe('sqlite');
  });

  test('returns pg when DB_MODE=postgres', () => {
    process.env.DB_MODE = 'postgres';
    expect(getDbMode()).toBe('pg');
  });

  test('returns pg when DB_MODE=postgresql', () => {
    process.env.DB_MODE = 'postgresql';
    expect(getDbMode()).toBe('pg');
  });

  test('returns sqlite when DB_MODE=sqlite', () => {
    process.env.DB_MODE = 'sqlite';
    expect(getDbMode()).toBe('sqlite');
  });

  test('is case-insensitive', () => {
    process.env.DB_MODE = 'POSTGRES';
    expect(getDbMode()).toBe('pg');
  });

  test('infers pg when AUTH_MODE=multi', () => {
    process.env.AUTH_MODE = 'multi';
    expect(getDbMode()).toBe('pg');
  });

  test('DB_MODE takes priority over AUTH_MODE', () => {
    process.env.DB_MODE = 'sqlite';
    process.env.AUTH_MODE = 'multi';
    expect(getDbMode()).toBe('sqlite');
  });

  test('returns sqlite for unknown DB_MODE values', () => {
    process.env.DB_MODE = 'mysql';
    expect(getDbMode()).toBe('sqlite');
  });

  test('AUTH_MODE inference is case-insensitive', () => {
    process.env.AUTH_MODE = 'MULTI';
    expect(getDbMode()).toBe('pg');
  });
});

// ── getDatabaseUrl ───────────────────────────────────────────────

describe('getDatabaseUrl', () => {
  test('returns DATABASE_URL when set', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/mydb';
    expect(getDatabaseUrl()).toBe('postgresql://user:pass@host:5432/mydb');
  });

  test('returns null when no env vars set', () => {
    expect(getDatabaseUrl()).toBeNull();
  });

  test('builds URL from DB_HOST and DB_USER with defaults', () => {
    process.env.DB_HOST = 'localhost';
    process.env.DB_USER = 'admin';
    expect(getDatabaseUrl()).toBe('postgresql://admin@localhost:5432/funny');
  });

  test('uses custom port when DB_PORT set', () => {
    process.env.DB_HOST = 'localhost';
    process.env.DB_USER = 'admin';
    process.env.DB_PORT = '5433';
    expect(getDatabaseUrl()).toBe('postgresql://admin@localhost:5433/funny');
  });

  test('includes password when DB_PASSWORD set', () => {
    process.env.DB_HOST = 'localhost';
    process.env.DB_USER = 'admin';
    process.env.DB_PASSWORD = 'secret';
    expect(getDatabaseUrl()).toBe('postgresql://admin:secret@localhost:5432/funny');
  });

  test('URL-encodes special characters in password', () => {
    process.env.DB_HOST = 'localhost';
    process.env.DB_USER = 'admin';
    process.env.DB_PASSWORD = 'p@ss:word';
    // Build expected URL dynamically to avoid triggering secret-lint on connection strings
    const expected = ['postgresql://', 'admin:', 'p%40ss%3Aword', '@localhost:5432/funny'].join('');
    expect(getDatabaseUrl()).toBe(expected);
  });

  test('uses custom db name when DB_NAME set', () => {
    process.env.DB_HOST = 'localhost';
    process.env.DB_USER = 'admin';
    process.env.DB_NAME = 'myapp';
    expect(getDatabaseUrl()).toBe('postgresql://admin@localhost:5432/myapp');
  });

  test('returns null when DB_HOST set but DB_USER missing', () => {
    process.env.DB_HOST = 'localhost';
    expect(getDatabaseUrl()).toBeNull();
  });

  test('returns null when DB_USER set but DB_HOST missing', () => {
    process.env.DB_USER = 'admin';
    expect(getDatabaseUrl()).toBeNull();
  });

  test('DATABASE_URL takes priority over individual vars', () => {
    process.env.DATABASE_URL = 'postgresql://full@url:5432/db';
    process.env.DB_HOST = 'localhost';
    process.env.DB_USER = 'admin';
    expect(getDatabaseUrl()).toBe('postgresql://full@url:5432/db');
  });
});
