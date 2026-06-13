/**
 * Regression tests for persisted runner credentials.
 *
 * The runner invite token is single-use: the server consumes it on the first
 * registration. The bearer token used to live only in memory, so every runner
 * restart failed with `401 Invalid runner invite token` (the saved invite in
 * ~/.funny/.env was already consumed). These tests cover the persistence
 * module that makes restarts resume the session instead.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  clearRunnerCredentials,
  loadRunnerCredentials,
  saveRunnerCredentials,
} from '../../services/runner-credentials.js';

const SERVER = 'https://funny.example.com';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-creds-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runner-credentials', () => {
  test('save → load roundtrip returns the stored credentials', () => {
    saveRunnerCredentials({ serverUrl: SERVER, runnerId: 'r1', token: 'runner_abc' }, dir);
    expect(loadRunnerCredentials(SERVER, dir)).toEqual({
      serverUrl: SERVER,
      runnerId: 'r1',
      token: 'runner_abc',
    });
  });

  test('load returns null when no file exists', () => {
    expect(loadRunnerCredentials(SERVER, dir)).toBeNull();
  });

  test('credentials for a different server are not reused', () => {
    saveRunnerCredentials(
      { serverUrl: 'https://other.example.com', runnerId: 'r1', token: 'runner_abc' },
      dir,
    );
    expect(loadRunnerCredentials(SERVER, dir)).toBeNull();
  });

  test('malformed file returns null instead of throwing', () => {
    writeFileSync(join(dir, 'runner-credentials.json'), 'not json');
    expect(loadRunnerCredentials(SERVER, dir)).toBeNull();
  });

  test('file missing required fields returns null', () => {
    writeFileSync(join(dir, 'runner-credentials.json'), JSON.stringify({ serverUrl: SERVER }));
    expect(loadRunnerCredentials(SERVER, dir)).toBeNull();
  });

  test('empty token is rejected', () => {
    writeFileSync(
      join(dir, 'runner-credentials.json'),
      JSON.stringify({ serverUrl: SERVER, runnerId: 'r1', token: '' }),
    );
    expect(loadRunnerCredentials(SERVER, dir)).toBeNull();
  });

  test('clear removes the file; clearing twice is safe', () => {
    saveRunnerCredentials({ serverUrl: SERVER, runnerId: 'r1', token: 'runner_abc' }, dir);
    clearRunnerCredentials(dir);
    expect(loadRunnerCredentials(SERVER, dir)).toBeNull();
    clearRunnerCredentials(dir); // no throw
  });

  test('credentials file is written with owner-only permissions (0600)', () => {
    saveRunnerCredentials({ serverUrl: SERVER, runnerId: 'r1', token: 'runner_abc' }, dir);
    const mode = statSync(join(dir, 'runner-credentials.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('stored file is human-readable JSON (operators can inspect/delete it)', () => {
    saveRunnerCredentials({ serverUrl: SERVER, runnerId: 'r1', token: 'runner_abc' }, dir);
    const raw = readFileSync(join(dir, 'runner-credentials.json'), 'utf-8');
    expect(JSON.parse(raw).runnerId).toBe('r1');
  });
});
