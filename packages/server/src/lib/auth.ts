/**
 * Better Auth instance for the central server.
 * Session-based auth with username + admin + organization plugins.
 *
 * Supports both SQLite (default/local) and PostgreSQL (team/cloud) modes.
 */

import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

import { getSchema } from '@funny/shared/db/schema';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, bearer, username, organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';

import { db, dbDialect } from '../db/index.js';
import { audit } from './audit.js';
import { DATA_DIR } from './data-dir.js';
import { log } from './logger.js';
import { validatePasswordStrength } from './password-policy.js';

const SECRET_PATH = resolve(DATA_DIR, 'auth-secret');

/**
 * Security M7 (decision needed): there is no graceful rotation flow for the
 * Better Auth signing secret today. Replacing `BETTER_AUTH_SECRET` (or the
 * on-disk file) invalidates every signed session immediately — every user is
 * logged out at the next request. A proper rotation needs:
 *
 *   1. Two-secret support — accept tokens signed by either the current
 *      secret or the previous one for a defined window (e.g. 7 days).
 *   2. An admin-only "rotate" endpoint that mints a new current secret,
 *      demotes the old one to "previous", and audits the action.
 *   3. Operator docs covering both compromise ("rotate now, revoke all
 *      sessions") and scheduled rotation paths.
 *
 * Better Auth does not natively support a secondary verification secret,
 * so the implementation will require either a custom verifier hook or a
 * patch upstream. Tracked separately — do not regress this comment until a
 * design exists.
 */
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

// Read-only org member (unified-rbac-grants, canonical rank 0). Previously the
// `TeamRole` type declared 'viewer' but no role was registered, so it was a
// phantom. A viewer can create nothing and administer nothing.
const viewer = ac.newRole({
  project: [],
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
  : [`http://localhost:${DEV_CLIENT_PORT}`, `http://127.0.0.1:${DEV_CLIENT_PORT}`];

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

/** Build the dialect-aware database config for Better Auth. */
function buildDatabaseConfig() {
  const s = getSchema(dbDialect);
  return drizzleAdapter(db, {
    provider: dbDialect === 'pg' ? 'pg' : 'sqlite',
    schema: {
      user: s.user,
      session: s.session,
      account: s.account,
      verification: s.verification,
      organization: s.organization,
      member: s.member,
      invitation: s.invitation,
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
        // Security M4: SameSite=Strict. No auth flow in this app brings the
        // user back via a cross-site redirect that needs the session cookie:
        //   - sign-in is email+password only (no third-party SSO)
        //   - the MCP OAuth callback authenticates via a `state` token, not
        //     the user's session cookie
        //   - invite-link registration runs on its own public route
        // Strict eliminates the CSRF residual that Lax permits on top-level
        // GET navigations. If a future feature adds third-party SSO, this
        // must be revisited.
        sameSite: 'strict',
        secure: cookieOpts.secure,
        httpOnly: true,
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
        roles: { owner, admin: adminRole, member, viewer },
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

    // Security M5: ADMIN_PASSWORD, when supplied, must clear the same
    // strength bar as a user-chosen password from the invite-link route.
    // Refuse weak values and fall through to a generated password — never
    // seed the admin account with a value below policy. The
    // `isGeneratedPassword` flag below also tracks the rejection so the
    // operator sees the credentials file with the auto-generated value.
    let password: string;
    let isGeneratedPassword: boolean;
    if (process.env.ADMIN_PASSWORD) {
      const policy = validatePasswordStrength(process.env.ADMIN_PASSWORD);
      if (!policy.ok) {
        log.error(
          'ADMIN_PASSWORD env did not meet password policy — falling back to a generated password',
          {
            namespace: 'auth',
            reason: policy.reason,
          },
        );
        audit({
          action: 'auth.weak_admin_password_rejected',
          actorId: null,
          detail: `ADMIN_PASSWORD env rejected: ${policy.reason}`,
          meta: {},
        });
        password = randomBytes(16).toString('base64url');
        isGeneratedPassword = true;
      } else {
        password = process.env.ADMIN_PASSWORD;
        isGeneratedPassword = false;
      }
    } else {
      password = randomBytes(16).toString('base64url');
      isGeneratedPassword = true;
    }

    const hash = await ctx.password.hash(password);
    const created = await ctx.internalAdapter.createUser({
      email,
      name: 'Admin',
      // Postgres stores email_verified as boolean; SQLite as a 0/1 integer
      // column, so the raw value must stay numeric there.
      emailVerified: dbDialect === 'pg' ? true : (1 as unknown as boolean),
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
      audit({
        action: 'user.create',
        actorId: null,
        detail: `Default admin account created: ${username}`,
        meta: { userId: created.id, email },
      });
      if (isGeneratedPassword) {
        // Security H9: never write the generated password to stderr or any log
        // stream — log pipelines (Abbacchio, journald, docker logs) commonly
        // capture stderr and would persist the secret indefinitely. Instead
        // write it to a mode-0600 file that only the server user can read,
        // and print just the file path to stderr as a one-time setup hint.
        const passwordPath = resolve(DATA_DIR, 'admin-password.txt');
        const body =
          `Generated admin credentials for funny\n` +
          `Username: ${username}\n` +
          `Password: ${password}\n\n` +
          `Delete this file after you have logged in and changed the password.\n` +
          `Set ADMIN_PASSWORD in the environment to skip credential generation.\n`;
        writeFileSync(passwordPath, body, { mode: 0o600 });
        process.stderr.write(
          `\n` +
            `  ========================================\n` +
            `  GENERATED ADMIN CREDENTIALS\n` +
            `  Username: ${username}\n` +
            `  Password written to: ${passwordPath}\n` +
            `  (file is mode 0600; delete after first login)\n` +
            `  ========================================\n\n`,
        );
        log.info(
          'Created admin account with generated password — credentials written to data dir',
          {
            namespace: 'auth',
            username,
            passwordPath,
          },
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
    log.error('Failed to create default admin account', {
      namespace: 'auth',
      error: err?.message ?? err,
      stack: err?.stack,
      code: err?.code,
      detail: err?.detail,
    });
  }
}
