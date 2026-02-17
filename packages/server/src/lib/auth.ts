import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, username } from 'better-auth/plugins';
import { db } from '../db/index.js';
import { resolve } from 'path';
import { homedir } from 'os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';

const AUTH_DIR = resolve(homedir(), '.funny');
const SECRET_PATH = resolve(AUTH_DIR, 'auth-secret');

function getOrCreateSecret(): string {
  mkdirSync(AUTH_DIR, { recursive: true });

  if (existsSync(SECRET_PATH)) {
    const secret = readFileSync(SECRET_PATH, 'utf-8').trim();
    if (secret.length > 0) return secret;
  }

  const secret = randomBytes(64).toString('hex');
  writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  console.log('[auth] Generated new auth secret');
  return secret;
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'sqlite' }),
  basePath: '/api/auth',
  secret: getOrCreateSecret(),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
  },
  session: {
    expiresIn: 7 * 24 * 60 * 60, // 7 days
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
    },
  },
  plugins: [
    username(),
    admin(),
  ],
});

/**
 * Ensure Better Auth tables exist and create default admin if needed.
 * Only called when AUTH_MODE=multi.
 */
export async function initBetterAuth(): Promise<void> {
  try {
    const { users } = await auth.api.listUsers({ query: { limit: 1 } });
    if (users.length === 0) {
      // Generate a random password instead of using a hardcoded default
      const password = randomBytes(16).toString('hex');
      await auth.api.createUser({
        body: {
          email: 'admin@local.host',
          password,
          name: 'Admin',
          username: 'admin',
          role: 'admin',
        },
      });
      console.log('[auth] ──────────────────────────────────────────────');
      console.log('[auth] Created default admin account.');
      console.log('[auth]   Username: admin');
      console.log(`[auth]   Password: ${password}`);
      console.log('[auth]   IMPORTANT: Change this password immediately!');
      console.log('[auth] ──────────────────────────────────────────────');
    }
  } catch (err) {
    console.error('[auth] Failed to initialize Better Auth:', err);
  }
}

/**
 * Reassign legacy data (user_id = '__local__') to the given userId.
 * Called on first login in multi mode.
 */
export function assignLegacyData(userId: string): void {
  try {
    const sqlite = (db as any).$client;
    sqlite.run(`UPDATE projects SET user_id = ? WHERE user_id = '__local__'`, [userId]);
    sqlite.run(`UPDATE threads SET user_id = ? WHERE user_id = '__local__'`, [userId]);
    sqlite.run(`UPDATE automations SET user_id = ? WHERE user_id = '__local__'`, [userId]);
  } catch (err) {
    console.warn('[auth] Failed to assign legacy data:', err);
  }
}
