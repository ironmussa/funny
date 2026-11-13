import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Issue #189: registering through an invite link must either make the new user
 * a member of the link's organization, or fail without consuming a slot or
 * leaving an account behind. The route tests mock Better Auth, which hid that
 * the real organization plugin refuses the join; this runs the installed one.
 */
test('invite registration joins the org with real Better Auth, or fails and releases the slot', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'funny-invite-real-auth-'));
  try {
    // A child process isolates the environment-driven singletons (DB, auth).
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        `
          const { eq, and } = await import('drizzle-orm');
          const { initDatabase, closeDatabase, db } = await import('./src/db/index.ts');
          const { autoMigrate } = await import('./src/db/migrate.ts');
          const { initBetterAuth, auth } = await import('./src/lib/auth.ts');
          const schema = await import('./src/db/schema.ts');
          const { inviteLinkPublicRoutes } = await import('./src/routes/invite-links.ts');

          const fail = (msg) => { throw new Error(msg); };
          const result = await initDatabase();
          if (result.isErr()) throw new Error(result.error);
          try {
            await autoMigrate();
            await initBetterAuth();
            const ctx = await auth.$context;
            const [admin] = await ctx.internalAdapter.listUsers(1, 0);
            const org = await auth.api.createOrganization({
              body: { name: 'Acme', slug: 'acme', userId: admin.id },
            });

            const seedLink = async (id, organizationId) => {
              await db.insert(schema.inviteLinks).values({
                id, organizationId, token: 'token-' + id, role: 'member',
                createdBy: admin.id, maxUses: '5', useCount: '0', revoked: '0',
                createdAt: new Date().toISOString(),
              });
            };
            const useCount = async (id) =>
              (await db.select().from(schema.inviteLinks).where(eq(schema.inviteLinks.id, id)))[0].useCount;
            const register = (token, username) =>
              inviteLinkPublicRoutes.request('/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, username, password: 'Invite-Test-Password-42' }),
              });

            // The join fails (the link's organization does not exist): no slot
            // is consumed and no account is left behind.
            await seedLink('broken', 'org-that-does-not-exist');
            const failed = await register('token-broken', 'newbie');
            if (failed.status === 200) fail('registration succeeded without joining the org');
            if ((await useCount('broken')) !== '0') fail('failed registration consumed a slot');
            if (await ctx.internalAdapter.findUserByEmail('newbie@invite.local')) {
              fail('failed registration left the account behind');
            }

            // A valid link: the same username can now register and becomes a member.
            await seedLink('ok', org.id);
            const ok = await register('token-ok', 'newbie');
            if (ok.status !== 200) fail('registration failed: ' + ok.status + ' ' + (await ok.text()));
            const { user } = await ok.json();
            const members = await db.select().from(schema.member).where(
              and(eq(schema.member.organizationId, org.id), eq(schema.member.userId, user.id)),
            );
            if (members.length !== 1 || members[0].role !== 'member') {
              fail('registered user is not a member of the org: ' + JSON.stringify(members));
            }
            if ((await useCount('ok')) !== '1') fail('successful registration did not consume a slot');

            // The forwarded session is signed in with the org active. Later
            // Set-Cookie values for the same cookie replace earlier ones.
            const jar = new Map();
            for (const c of ok.headers.getSetCookie()) {
              const pair = c.split(';')[0];
              jar.set(pair.slice(0, pair.indexOf('=')), pair);
            }
            const session = await auth.api.getSession({
              headers: new Headers({ cookie: [...jar.values()].join('; ') }),
            });
            if (session?.user.id !== user.id) fail('registration did not sign the user in');
            if (session.session.activeOrganizationId !== org.id) {
              fail('the org is not active in the new session: ' + session.session.activeOrganizationId);
            }
          } finally {
            await closeDatabase();
          }
        `,
      ],
      {
        cwd: resolve(import.meta.dir, '../..'),
        env: {
          ...process.env,
          FUNNY_DATA_DIR: dataDir,
          DATABASE_URL: '',
          ADMIN_USERNAME: 'inviteadmin',
          ADMIN_EMAIL: 'inviteadmin@example.com',
          ADMIN_PASSWORD: 'Invite-Admin-Password-739!',
          BETTER_AUTH_SECRET: 'invite-test-secret-with-at-least-32-characters',
          BETTER_AUTH_BASE_URL: 'http://localhost:3001',
          BETTER_AUTH_COOKIE_SECURE: 'false',
          CORS_ORIGINS: 'http://localhost:3001',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stdout + stderr).toBe(0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30_000);
