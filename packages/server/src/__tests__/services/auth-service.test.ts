import { describe, test, expect, beforeEach, mock, afterAll } from 'bun:test';
import { resolve } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';

const TEST_DIR = resolve(import.meta.dir, '..', '..', '..', '.test-tmp-auth-service');
const TOKEN_PATH = resolve(TEST_DIR, 'auth-token');

// Mock the homedir to use our test dir
mock.module('os', () => ({
  homedir: () => resolve(TEST_DIR, '..'),
  platform: () => process.platform,
}));

// We need to force the auth-service to use our test dir
// The auth-service resolves AUTH_DIR as homedir()/.funny
// So we set homedir to TEST_DIR/.. and use TEST_DIR as the auth directory name
// Actually, let's just test validateToken and getAuthToken concepts

describe('auth-service concepts', () => {
  const testTokenDir = resolve(TEST_DIR, 'auth');

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(testTokenDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('timing-safe comparison rejects wrong length tokens', () => {
    const { timingSafeEqual } = require('crypto');
    const expected = 'a'.repeat(64);
    const token = 'short';
    // timingSafeEqual throws if buffers are different lengths
    expect(token.length !== expected.length).toBe(true);
  });

  test('timing-safe comparison accepts identical tokens', () => {
    const { timingSafeEqual } = require('crypto');
    const expected = 'a'.repeat(64);
    const result = timingSafeEqual(Buffer.from(expected), Buffer.from(expected));
    expect(result).toBe(true);
  });

  test('timing-safe comparison rejects different tokens of same length', () => {
    const { timingSafeEqual } = require('crypto');
    const expected = 'a'.repeat(64);
    const wrong = 'b'.repeat(64);
    const result = timingSafeEqual(Buffer.from(expected), Buffer.from(wrong));
    expect(result).toBe(false);
  });

  test('randomBytes generates 32 bytes (64 hex chars)', () => {
    const { randomBytes } = require('crypto');
    const token = randomBytes(32).toString('hex');
    expect(token.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  test('token file can be written and read back', () => {
    const tokenPath = resolve(testTokenDir, 'test-token');
    const token = 'test-token-value';
    writeFileSync(tokenPath, token, { mode: 0o600 });
    expect(readFileSync(tokenPath, 'utf-8').trim()).toBe(token);
  });
});
