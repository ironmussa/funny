/**
 * Importing server modules touches no filesystem: the data dir and the log
 * file are created by the host (docs/plans/cloudflare-portability.md, Phase 1).
 * Runs in a child process so the modules load fresh, outside the test env
 * (NODE_ENV=test disables the file transport).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '../..');
const root = mkdtempSync(join(tmpdir(), 'funny-datadir-'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

function runScript(dataDir: string, body: string) {
  const script = `
    const logger = await import(${JSON.stringify(join(SRC, 'lib/logger.ts'))});
    await import(${JSON.stringify(join(SRC, 'lib/data-dir.ts'))});
    await import(${JSON.stringify(join(SRC, 'lib/server-secrets.ts'))});
    await import(${JSON.stringify(join(SRC, 'lib/crypto.ts'))});
    await import(${JSON.stringify(join(SRC, 'db/index.ts'))});
    await import(${JSON.stringify(join(SRC, 'app.ts'))});
    ${body}
  `;
  const { DATABASE_URL: _ignored, ...base } = process.env;
  return Bun.spawnSync(['bun', '-e', script], {
    env: { ...base, NODE_ENV: 'development', FUNNY_DATA_DIR: dataDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('data dir side effects', () => {
  test('importing the server modules does not create the data dir', () => {
    const dataDir = join(root, 'import-only');
    const result = runScript(dataDir, '');
    expect(result.exitCode).toBe(0);
    expect(existsSync(dataDir)).toBe(false);
  });

  test('the host creates it owner-only and attaches the log file', async () => {
    const dataDir = join(root, 'hosted');
    const result = runScript(
      dataDir,
      `
      const { ensureDataDir } = await import(${JSON.stringify(join(SRC, 'lib/data-dir.ts'))});
      ensureDataDir();
      const dir = logger.attachFileLogTransport();
      logger.log.info('file-transport-probe', { namespace: 'test' });
      await new Promise((r) => setTimeout(r, 300));
      console.log('LOGDIR=' + dir);
      `,
    );
    expect(result.exitCode).toBe(0);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    const logDir = join(dataDir, 'logs');
    expect(result.stdout.toString()).toContain(`LOGDIR=${logDir}`);
    const files = readdirSync(logDir).filter((f) => f.startsWith('server-'));
    expect(files.length).toBe(1);
    expect(readFileSync(join(logDir, files[0]), 'utf-8')).toContain('file-transport-probe');
  });
});
