/**
 * Auth Service — generates and validates a bearer token for API access.
 * Token is stored at ~/.funny/auth-token and cached in memory.
 */

import { resolve } from 'path';
import { homedir } from 'os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { randomBytes, timingSafeEqual } from 'crypto';
import { log } from '../lib/abbacchio.js';

const AUTH_DIR = resolve(homedir(), '.funny');
const TOKEN_PATH = resolve(AUTH_DIR, 'auth-token');

let cachedToken: string | null = null;

/**
 * Get (or generate on first call) the auth token.
 * Reads from ~/.funny/auth-token, creating it if it doesn't exist.
 */
export function getAuthToken(): string {
  if (cachedToken) return cachedToken;

  mkdirSync(AUTH_DIR, { recursive: true });

  if (existsSync(TOKEN_PATH)) {
    cachedToken = readFileSync(TOKEN_PATH, 'utf-8').trim();
    if (cachedToken.length > 0) return cachedToken;
  }

  // Generate a 32-byte (256-bit) random token, hex-encoded = 64 chars
  cachedToken = randomBytes(32).toString('hex');
  writeFileSync(TOKEN_PATH, cachedToken, { mode: 0o600 });
  log.info('Generated new auth token', { namespace: 'auth', path: TOKEN_PATH });
  return cachedToken;
}

/**
 * Validate a provided token against the stored token.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function validateToken(token: string): boolean {
  const expected = getAuthToken();
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
