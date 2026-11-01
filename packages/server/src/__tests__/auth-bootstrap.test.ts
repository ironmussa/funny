import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the real auth adapter seeds one admin and supports login after restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'funny-auth-bootstrap-'));
  try {
    // Isolate environment-driven singletons and use the installed Better Auth
    // adapter, rather than the route tests' authentication mocks.
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        `
          const { initDatabase, closeDatabase } = await import('./src/db/index.ts');
          const { autoMigrate } = await import('./src/db/migrate.ts');
          const { initBetterAuth, auth } = await import('./src/lib/auth.ts');
          const result = await initDatabase();
          if (result.isErr()) throw new Error(result.error);
          try {
            await autoMigrate();
            await initBetterAuth();
            const first = await (await auth.$context).internalAdapter.listUsers(10, 0);
            if (first.length !== 1 || first[0].role !== 'admin') {
              throw new Error('Bootstrap did not create exactly one admin');
            }
            await initBetterAuth();
            const second = await (await auth.$context).internalAdapter.listUsers(10, 0);
            if (second.length !== 1 || second[0].id !== first[0].id) {
              throw new Error('Repeated initialization changed the admin account');
            }
            const response = await auth.handler(new Request('http://localhost:3001/api/auth/sign-in/username', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3001' },
              body: JSON.stringify({ username: 'bootstrapadmin', password: process.env.ADMIN_PASSWORD }),
            }));
            if (response.status !== 200) throw new Error('Admin login failed: ' + response.status);
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
          ADMIN_USERNAME: 'bootstrapadmin',
          ADMIN_EMAIL: 'bootstrap@example.com',
          ADMIN_PASSWORD: 'Bootstrap-Test-Password-739!',
          BETTER_AUTH_SECRET: 'bootstrap-test-secret-with-at-least-32-characters',
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
}, 20_000);
