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
import {
  user as authUser,
  session as authSession,
  account as authAccount,
  verification as authVerification,
  organization as authOrganization,
  member as authMember,
  invitation as authInvitation,
} from '@funny/shared/db/schema-sqlite';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, bearer, username, organization } from 'better-auth/plugins';
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
  : ['http://localhost:*', 'http://127.0.0.1:*'];

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

  // SQLite mode — pass schema explicitly so drizzle adapter can locate Better Auth tables
  return drizzleAdapter(db, {
    provider: 'sqlite',
    schema: {
      user: authUser,
      session: authSession,
      account: authAccount,
      verification: authVerification,
      organization: authOrganization,
      member: authMember,
      invitation: authInvitation,
    },
  });
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
      bearer(),
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

  // runMigrations() only works with the Kysely adapter (PostgreSQL mode).
  // In SQLite mode, Better Auth tables are created by the server's own migration system.
  if (getDbMode() === 'postgres') {
    try {
      const ctx = await _auth.$context;
      await ctx.runMigrations();
    } catch (err) {
      log.error('Failed to run Better Auth migrations', { namespace: 'auth', error: err as any });
      throw err;
    }
  }

  try {
    const ctx = await _auth.$context;

    // Only seed on first run — skip if any users already exist
    const existingUsers = await ctx.internalAdapter.listUsers(1);
    if (existingUsers && existingUsers.length > 0) return;

    const email = process.env.ADMIN_EMAIL ?? 'admin@local.host';
    const username = process.env.ADMIN_USERNAME ?? 'admin';
    const isGeneratedPassword = !process.env.ADMIN_PASSWORD;
    const password = process.env.ADMIN_PASSWORD ?? randomBytes(16).toString('base64url');

    const hash = await ctx.password.hash(password);
    const created = await ctx.internalAdapter.createUser({
      email,
      name: 'Admin',
      emailVerified: 1,
      role: 'admin',
      username,
    });
    if (created) {
      await ctx.internalAdapter.linkAccount({
        userId: created.id,
        providerId: 'credential',
        accountId: created.id,
        password: hash,
      });
      if (isGeneratedPassword) {
        log.warn(
          `\n` +
            `  ========================================\n` +
            `  GENERATED ADMIN CREDENTIALS\n` +
            `  Username: ${username}\n` +
            `  Password: ${password}\n` +
            `  ========================================\n` +
            `  Change this password after first login.\n` +
            `  Set ADMIN_PASSWORD env var to use a fixed password.\n`,
          { namespace: 'auth' },
        );
      } else {
        log.info('Created admin account with configured password', {
          namespace: 'auth',
          username,
          email,
        });
      }
    }
  } catch (err: any) {
    log.error('Failed to create default admin account', { namespace: 'auth', error: err });
  }
}
