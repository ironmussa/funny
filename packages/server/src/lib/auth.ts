/**
 * Better Auth instance for the central server.
 * Session-based auth with username + admin + organization plugins.
 */

import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, username, organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';

import { db } from '../db/index.js';
import { DATA_DIR } from './data-dir.js';
import { log } from './logger.js';

const SECRET_PATH = resolve(DATA_DIR, 'auth-secret');

function getOrCreateSecret(): string {
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

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
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

/**
 * Ensure Better Auth tables exist and create default admin if needed.
 */
export async function initBetterAuth(): Promise<void> {
  try {
    const ctx = await auth.$context;
    await ctx.runMigrations();
  } catch (err) {
    log.error('Failed to run Better Auth migrations', { namespace: 'auth', error: err as any });
    throw err;
  }

  try {
    const password = 'admin';
    const result = await auth.api.createUser({
      body: {
        email: 'admin@local.host',
        password,
        name: 'Admin',
        role: 'admin',
        data: { username: 'admin' },
      },
    } as any);

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
