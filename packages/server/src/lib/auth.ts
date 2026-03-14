/**
 * Better Auth instance for the central server.
 * Session-based auth with username + admin + organization plugins.
 *
 * Supports both SQLite (default/local) and PostgreSQL (team/cloud) modes.
 */

import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

import { getDbMode, getDatabaseUrl } from '@funny/shared/db/db-mode';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, username, organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';

import { db } from '../db/index.js';
import { DATA_DIR } from './data-dir.js';
import { log } from './logger.js';

const SECRET_PATH = resolve(DATA_DIR, 'auth-secret');

function getOrCreateSecret(): string {
  // Prefer env var (essential for platforms like Railway where the filesystem is ephemeral)
  if (process.env.BETTER_AUTH_SECRET) {
    return process.env.BETTER_AUTH_SECRET;
  }

  if (existsSync(SECRET_PATH)) {
    const secret = readFileSync(SECRET_PATH, 'utf-8').trim();
    if (secret.length > 0) return secret;
  }

  const secret = randomBytes(64).toString('hex');
  writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  log.info('Generated new auth secret', { namespace: 'auth' });
  return secret;
}

// ── Access Control ──────────────────────────────────────────────

const statement = {
  project: ['create', 'update', 'delete'],
  runner: ['create', 'update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
} as const;

export const ac = createAccessControl(statement);

const member = ac.newRole({
  project: ['create'],
  runner: [],
  member: [],
  invitation: [],
});

const adminRole = ac.newRole({
  project: ['create', 'update', 'delete'],
  runner: ['create', 'update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

const owner = ac.newRole({
  project: ['create', 'update', 'delete'],
  runner: ['create', 'update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

// ── Auth Instance ───────────────────────────────────────────────

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
  : ['http://localhost:5173', 'http://127.0.0.1:5173'];

const PORT = parseInt(process.env.PORT || '3001', 10);

/**
 * Build the database config for Better Auth based on the detected mode.
 * - SQLite: uses drizzleAdapter with the shared Drizzle instance
 * - PostgreSQL: uses pg.Pool with Kysely dialect
 */
function buildDatabaseConfig(): any {
  const mode = getDbMode();

  if (mode === 'postgres') {
    const pg = require('pg') as typeof import('pg');
    const { Kysely, PostgresDialect } = require('kysely') as typeof import('kysely');

    const Pool = pg.default?.Pool ?? pg.Pool;
    const authPool = new Pool({ connectionString: getDatabaseUrl()! });
    const kyselyDb = new Kysely<any>({
      dialect: new PostgresDialect({ pool: authPool }),
    });

    return {
      db: kyselyDb,
      type: 'postgres' as const,
    };
  }

  // SQLite mode — use drizzle adapter
  return drizzleAdapter(db, { provider: 'sqlite' });
}

// Lazy init — auth is created on first call to initBetterAuth()
let _auth: ReturnType<typeof betterAuth> | null = null;

export const auth = new Proxy({} as ReturnType<typeof betterAuth>, {
  get(_target, prop) {
    if (!_auth) {
      throw new Error('Auth not initialized. Call initBetterAuth() at startup.');
    }
    return (_auth as any)[prop];
  },
});

/**
 * Ensure Better Auth tables exist and create default admin if needed.
 */
export async function initBetterAuth(): Promise<void> {
  _auth = betterAuth({
    database: buildDatabaseConfig(),
    baseURL: process.env.BETTER_AUTH_BASE_URL || `http://localhost:${PORT}`,
    basePath: '/api/auth',
    secret: getOrCreateSecret(),
    trustedOrigins: corsOrigins,
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
    advanced: {
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: !!process.env.BETTER_AUTH_BASE_URL?.startsWith('https'),
        path: '/',
      },
    },
    plugins: [
      username(),
      admin(),
      organization({
        allowUserToCreateOrganization: true,
        organizationLimit: 50,
        membershipLimit: 100,
        creatorRole: 'owner',
        ac,
        roles: { owner, admin: adminRole, member },
      }),
    ],
  });

  try {
    const ctx = await _auth.$context;
    await ctx.runMigrations();
  } catch (err) {
    log.error('Failed to run Better Auth migrations', { namespace: 'auth', error: err as any });
    throw err;
  }

  try {
    const password = 'admin';
    const result = await (_auth.api as any).createUser({
      body: {
        email: 'admin@local.host',
        password,
        name: 'Admin',
        role: 'admin',
        data: { username: 'admin' },
      },
    });

    if ((result as any)?.user) {
      log.info('Created default admin account', {
        namespace: 'auth',
        username: 'admin',
        password,
        important: 'Change this password immediately!',
      });
    }
  } catch (err: any) {
    if (err?.message?.includes('already') || err?.body?.message?.includes('already')) {
      return;
    }
    log.error('Failed to initialize Better Auth', { namespace: 'auth', error: err });
  }
}
