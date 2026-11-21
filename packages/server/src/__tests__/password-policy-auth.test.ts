import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { validateAuthRequestPassword } from '../lib/password-policy.js';

describe('validateAuthRequestPassword', () => {
  test('checks the password field of every endpoint that sets one', () => {
    for (const [path, field] of [
      ['/change-password', 'newPassword'],
      ['/reset-password', 'newPassword'],
      ['/set-password', 'newPassword'],
      ['/admin/set-user-password', 'newPassword'],
      ['/admin/create-user', 'password'],
      ['/sign-up/email', 'password'],
    ] as const) {
      expect(validateAuthRequestPassword(path, { [field]: 'Abcdefg1' }).ok).toBe(false);
      expect(validateAuthRequestPassword(path, { [field]: 'abcdefghij1' }).ok).toBe(false);
      expect(validateAuthRequestPassword(path, { [field]: 'Abcdefghij1' }).ok).toBe(true);
    }
    expect(validateAuthRequestPassword('/change-password', {}).ok).toBe(false);
  });

  test('ignores endpoints that set no password, and admin create without one', () => {
    expect(validateAuthRequestPassword('/sign-in/username', { password: 'x' }).ok).toBe(true);
    expect(validateAuthRequestPassword('/admin/create-user', { email: 'a@b.c' }).ok).toBe(true);
  });
});

/**
 * Issue #201: password change and admin-created users accepted 8-character
 * passwords. Runs the installed Better Auth so the hook is exercised end to end.
 */
test('real Better Auth refuses passwords below policy on change and admin paths', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'funny-password-policy-'));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        `
          const { initDatabase, closeDatabase } = await import('./src/db/index.ts');
          const { autoMigrate } = await import('./src/db/migrate.ts');
          const { initBetterAuth, auth } = await import('./src/lib/auth.ts');
          const fail = (msg) => { throw new Error(msg); };
          const result = await initDatabase();
          if (result.isErr()) throw new Error(result.error);
          try {
            await autoMigrate();
            await initBetterAuth();
            const base = 'http://localhost:3001/api/auth';
            const post = (path, body, cookie) => auth.handler(new Request(base + path, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Origin: 'http://localhost:3001',
                ...(cookie ? { cookie } : {}),
              },
              body: JSON.stringify(body),
            }));
            const signIn = await post('/sign-in/username', {
              username: 'policyadmin', password: process.env.ADMIN_PASSWORD,
            });
            if (signIn.status !== 200) fail('admin sign-in failed: ' + signIn.status);
            const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

            const weak = ['Abcdef12', 'abcdefghij12'];
            for (const pw of weak) {
              const created = await post('/admin/create-user', {
                email: 'weak@example.com', password: pw, name: 'Weak',
              }, cookie);
              if (created.status !== 400) fail('admin create accepted ' + pw + ': ' + created.status);
              const changed = await post('/change-password', {
                currentPassword: process.env.ADMIN_PASSWORD, newPassword: pw,
              }, cookie);
              if (changed.status !== 400) fail('change accepted ' + pw + ': ' + changed.status);
            }

            const ok = await post('/admin/create-user', {
              email: 'strong@example.com', password: 'Strong-Password-42', name: 'Strong',
            }, cookie);
            if (ok.status !== 200) fail('admin create refused a strong password: ' + ok.status + ' ' + await ok.text());
            const { user } = await ok.json();
            const setWeak = await post('/admin/set-user-password', {
              userId: user.id, newPassword: 'Abcdef12',
            }, cookie);
            if (setWeak.status !== 400) fail('admin set-password accepted a weak password: ' + setWeak.status);
            const changed = await post('/change-password', {
              currentPassword: process.env.ADMIN_PASSWORD, newPassword: 'Another-Strong-Pass-7',
            }, cookie);
            if (changed.status !== 200) fail('change refused a strong password: ' + changed.status + ' ' + await changed.text());
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
          ADMIN_USERNAME: 'policyadmin',
          ADMIN_EMAIL: 'policyadmin@example.com',
          ADMIN_PASSWORD: 'Policy-Admin-Password-739!',
          BETTER_AUTH_SECRET: 'policy-test-secret-with-at-least-32-characters',
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
