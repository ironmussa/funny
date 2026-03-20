/**
 * Better Auth instance for the central server.
 * Session-based auth with username + admin + organization plugins.
 *
 * Supports both SQLite (default/local) and PostgreSQL (team/cloud) modes.
 */

import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

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

/** Vite dev port (from root `.env` when server uses --env-file) — keeps CORS/trustedOrigins in sync */
const DEV_CLIENT_PORT = process.env.VITE_PORT || '5173';

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
  : [
      `http://localhost:${DEV_CLIENT_PORT}`,
      `http://127.0.0.1:${DEV_CLIENT_PORT}`,
      'http://localhost:*',
      'http://127.0.0.1:*',
    ];

const PORT = parseInt(process.env.PORT || '3001', 10);

/**
 * Session cookie Secure flag + Better Auth `__Secure-` cookie prefix.
 * If `.env` sets BETTER_AUTH_BASE_URL to https://… (e.g. production) but you still open the UI on
 * http://localhost, browsers drop Secure cookies — login looks OK (JSON user) then /api/* returns 401.
 */
function resolveSessionCookieSecure(): { secure: boolean; useSecureCookies?: boolean } {
  const o = process.env.BETTER_AUTH_COOKIE_SECURE;
  const forceInsecure = o === 'false' || o === '0';
  const forceSecure = o === 'true' || o === '1';
  const httpsBase = !!process.env.BETTER_AUTH_BASE_URL?.startsWith('https');
  if (forceInsecure) {
    return {
      secure: false,
      ...(httpsBase ? { useSecureCookies: false } : {}),
    };
  }
  if (forceSecure) {
    return { secure: true, useSecureCookies: true };
  }
  return { secure: httpsBase };
}

/** Build the SQLite database config for Better Auth. */
function buildDatabaseConfig() {
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
  const cookieOpts = resolveSessionCookieSecure();
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
      // Explicitly set useSecureCookies based on the base URL protocol.
      // When unset, Better Auth may auto-detect and use Secure cookies,
      // which browsers silently reject on http:// origins.
      useSecureCookies: cookieOpts.useSecureCookies ?? cookieOpts.secure,
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: cookieOpts.secure,
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

  // Better Auth tables are created by the server's own migration system (027_better_auth_tables).

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
