/**
 * @domain subdomain: Authentication
 * @domain subdomain-type: generic
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: Database
 */

import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, username, organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { sql } from 'drizzle-orm';
import pg from 'pg';

import { getDatabaseUrl } from '../db/db-mode.js';
import { db, dbMode, dbRun } from '../db/index.js';
import { DATA_DIR } from './data-dir.js';
import { sendEmail } from './email.js';
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
  thread: ['create', 'start', 'stop', 'delete'],
  git: ['commit', 'push', 'create-pr'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
} as const;

export const ac = createAccessControl(statement);

const viewer = ac.newRole({
  project: [],
  thread: [],
  git: [],
  member: [],
  invitation: [],
});

const member = ac.newRole({
  project: ['create'],
  thread: ['create', 'start', 'stop'],
  git: ['commit', 'push', 'create-pr'],
  member: [],
  invitation: [],
});

const adminRole = ac.newRole({
  project: ['create', 'update', 'delete'],
  thread: ['create', 'start', 'stop', 'delete'],
  git: ['commit', 'push', 'create-pr'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

const owner = ac.newRole({
  project: ['create', 'update', 'delete'],
  thread: ['create', 'start', 'stop', 'delete'],
  git: ['commit', 'push', 'create-pr'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

// ── Auth Instance ───────────────────────────────────────────────

const authPool =
  dbMode === 'postgres' ? new pg.Pool({ connectionString: getDatabaseUrl()! }) : null;

export const auth = betterAuth({
  database: dbMode === 'postgres' ? authPool! : drizzleAdapter(db, { provider: 'sqlite' }),
  basePath: '/api/auth',
  secret: getOrCreateSecret(),
  trustedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
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
      roles: { owner, admin: adminRole, member, viewer },
      schema: {
        organization: {
          fields: {
            anthropicApiKey: {
              type: 'string',
              required: false,
              input: true,
            },
            defaultModel: {
              type: 'string',
              required: false,
              input: true,
            },
            defaultMode: {
              type: 'string',
              required: false,
              input: true,
            },
            defaultPermissionMode: {
              type: 'string',
              required: false,
              input: true,
            },
          },
        },
      },
      async sendInvitationEmail({ email, organization, role, inviter }) {
        const inviterName = inviter?.user?.name || inviter?.user?.email || 'A team member';
        const roleName = role || 'member';
        const orgName = organization.name || 'a team';

        const html = `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
            <h2 style="margin-top: 0;">You've been invited to join ${orgName}</h2>
            <p><strong>${inviterName}</strong> has invited you to join <strong>${orgName}</strong> as a <strong>${roleName}</strong>.</p>
            <p>Log in to Funny to accept the invitation and start collaborating.</p>
            <p style="color: #666; font-size: 13px; margin-top: 24px;">
              This invitation expires in 48 hours. If you don't have an account, ask your team admin to create one for you.
            </p>
          </div>
        `;

        const sent = await sendEmail(
          email,
          `You've been invited to join ${orgName} on Funny`,
          html,
        );
        if (!sent) {
          throw new Error(
            'SMTP is not configured. Configure email settings in Settings before sending invitations.',
          );
        }
      },
    }),
  ],
});

/**
 * Ensure Better Auth tables exist and create default admin if needed.
 * Only called when AUTH_MODE=multi.
 */
export async function initBetterAuth(): Promise<void> {
  // Ensure Better Auth tables exist (user, session, account, organization, etc.)
  try {
    const ctx = await auth.$context;
    await ctx.runMigrations();
  } catch (err) {
    log.error('Failed to run Better Auth migrations', { namespace: 'auth', error: err });
    throw err;
  }

  try {
    const password = 'admin';
    // Use admin plugin's createUser to bypass disableSignUp restriction
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
    // "User already exists" is expected after first boot
    if (err?.message?.includes('already') || err?.body?.message?.includes('already')) {
      return;
    }
    log.error('Failed to initialize Better Auth', { namespace: 'auth', error: err });
  }
}

/**
 * Reassign legacy data (user_id = '__local__') to the given userId.
 * Called on first login in multi mode.
 */
export async function assignLegacyData(userId: string): Promise<void> {
  try {
    await dbRun(sql`UPDATE projects SET user_id = ${userId} WHERE user_id = '__local__'`);
    await dbRun(sql`UPDATE threads SET user_id = ${userId} WHERE user_id = '__local__'`);
    await dbRun(sql`UPDATE automations SET user_id = ${userId} WHERE user_id = '__local__'`);
  } catch (err) {
    log.warn('Failed to assign legacy data', { namespace: 'auth', error: err });
  }
}
