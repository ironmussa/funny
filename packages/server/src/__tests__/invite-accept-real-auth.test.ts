import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Issue #234: the invite routes were only tested against a Better Auth mock.
 * This runs `POST /api/invite-links/accept` (an existing, signed-in user joins
 * a second organization) against the installed Better Auth: the user becomes a
 * member with the link's role, the org becomes active in their session, one
 * slot is consumed, and accepting again is a no-op that consumes nothing.
 */
test('an existing user accepts an invite link with real Better Auth', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'funny-invite-accept-real-auth-'));
  try {
    // A child process isolates the environment-driven singletons (DB, auth).
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        `
          const { eq, and } = await import('drizzle-orm');
          const { Hono } = await import('hono');
          const { initDatabase, closeDatabase, db } = await import('./src/db/index.ts');
          const { autoMigrate } = await import('./src/db/migrate.ts');
          const { initBetterAuth, auth } = await import('./src/lib/auth.ts');
          const schema = await import('./src/db/schema.ts');
          const { inviteLinkPublicRoutes, inviteLinkRoutes } = await import('./src/routes/invite-links.ts');

          const fail = (msg) => { throw new Error(msg); };
          const result = await initDatabase();
          if (result.isErr()) throw new Error(result.error);
          try {
            await autoMigrate();
            await initBetterAuth();
            const ctx = await auth.$context;
            const [admin] = await ctx.internalAdapter.listUsers(1, 0);
            const first = await auth.api.createOrganization({
              body: { name: 'First', slug: 'first', userId: admin.id },
            });
            const second = await auth.api.createOrganization({
              body: { name: 'Second', slug: 'second', userId: admin.id },
            });

            const seedLink = async (id, organizationId, role) => {
              await db.insert(schema.inviteLinks).values({
                id, organizationId, token: 'token-' + id, role,
                createdBy: admin.id, maxUses: '5', useCount: '0', revoked: '0',
                createdAt: new Date().toISOString(),
              });
            };
            const useCount = async (id) =>
              (await db.select().from(schema.inviteLinks).where(eq(schema.inviteLinks.id, id)))[0].useCount;
            const cookieHeader = (res, previous = new Map()) => {
              // Later Set-Cookie values for the same cookie replace earlier ones.
              const jar = new Map(previous);
              for (const c of res.headers.getSetCookie()) {
                const pair = c.split(';')[0];
                jar.set(pair.slice(0, pair.indexOf('=')), pair);
              }
              return jar;
            };

            // An existing user: registered through a link of the first org.
            await seedLink('first', first.id, 'member');
            const registered = await inviteLinkPublicRoutes.request('/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: 'token-first', username: 'joiner', password: 'Invite-Test-Password-42' }),
            });
            if (registered.status !== 200) fail('setup registration failed: ' + (await registered.text()));
            const { user } = await registered.json();
            let jar = cookieHeader(registered);

            // The protected routes read the caller from the auth middleware.
            const app = new Hono();
            app.use('*', async (c, next) => { c.set('userId', user.id); await next(); });
            app.route('/', inviteLinkRoutes);
            const accept = (token) =>
              app.request('/accept', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', cookie: [...jar.values()].join('; ') },
                body: JSON.stringify({ token }),
              });

            await seedLink('second', second.id, 'admin');
            const accepted = await accept('token-second');
            if (accepted.status !== 200) fail('accept failed: ' + accepted.status + ' ' + (await accepted.text()));
            const body = await accepted.json();
            if (body.organizationId !== second.id || body.alreadyMember) {
              fail('unexpected accept response: ' + JSON.stringify(body));
            }
            const members = await db.select().from(schema.member).where(
              and(eq(schema.member.organizationId, second.id), eq(schema.member.userId, user.id)),
            );
            if (members.length !== 1 || members[0].role !== 'admin') {
              fail('the user is not an admin member of the second org: ' + JSON.stringify(members));
            }
            if ((await useCount('second')) !== '1') fail('accepting did not consume one slot');

            jar = cookieHeader(accepted, jar);
            const session = await auth.api.getSession({
              headers: new Headers({ cookie: [...jar.values()].join('; ') }),
            });
            if (session?.session.activeOrganizationId !== second.id) {
              fail('the org is not active in the session: ' + session?.session.activeOrganizationId);
            }

            // Accepting again: already a member, nothing consumed, no second row.
            const again = await accept('token-second');
            const againBody = await again.json();
            if (again.status !== 200 || !againBody.alreadyMember) {
              fail('second accept: ' + again.status + ' ' + JSON.stringify(againBody));
            }
            if ((await useCount('second')) !== '1') fail('a repeated accept consumed a slot');
            const after = await db.select().from(schema.member).where(
              and(eq(schema.member.organizationId, second.id), eq(schema.member.userId, user.id)),
            );
            if (after.length !== 1) fail('a repeated accept added a second membership');
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
