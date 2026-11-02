/**
 * `$BROWSER` bridge: a URL opened by an agent-run command (through the real
 * shim script) loads in the thread's browser session, and only for threads
 * the user owns.
 */

import { execFileSync } from 'child_process';
import { rmSync } from 'fs';

import { afterAll, describe, expect, test, vi } from 'vitest';

const dataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/funny-open-url-${Date.now()}`;
  process.env.FUNNY_DATA_DIR = dir;
  return dir;
});

const mocks = vi.hoisted(() => ({
  openForThread: vi.fn(async () => null),
  getThread: vi.fn(async (id: string) =>
    id === 'own-thread' ? { id, userId: 'u1' } : { id, userId: 'someone-else' },
  ),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/browser-session-manager.js', () => ({
  browserSessionManager: { openForThread: mocks.openForThread },
}));
vi.mock('../../services/thread-manager.js', () => ({ getThread: mocks.getThread }));

import {
  browserOpenEnv,
  closeOpenUrlWatchers,
  parseDropFile,
} from '../../services/browser-automation/open-url-bridge.js';

describe('$BROWSER bridge', () => {
  afterAll(() => {
    closeOpenUrlWatchers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('parses drop files', () => {
    expect(parseDropFile('t1\nhttps://x.test\n')).toEqual({
      threadId: 't1',
      url: 'https://x.test',
    });
    expect(parseDropFile('only-one-line')).toBeNull();
  });

  test('a URL opened through the shim loads in the thread session', async () => {
    const env = await browserOpenEnv('u1', 'own-thread');
    expect(env.BROWSER).toMatch(/funny-open-url$/);
    const out = execFileSync('sh', [env.BROWSER, 'https://dash.cloudflare.com/oauth?x=1'], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    expect(out).toContain('Opened in the Funny browser panel');
    await vi.waitFor(() =>
      expect(mocks.openForThread).toHaveBeenCalledWith(
        'u1',
        'own-thread',
        'https://dash.cloudflare.com/oauth?x=1',
      ),
    );
  });

  test("requests for another user's thread are ignored", async () => {
    mocks.openForThread.mockClear();
    const env = await browserOpenEnv('u1', 'own-thread');
    execFileSync('sh', [env.BROWSER, 'https://example.test'], {
      env: { ...process.env, ...env, FUNNY_THREAD_ID: 'foreign-thread' },
    });
    await vi.waitFor(() => expect(mocks.getThread).toHaveBeenCalledWith('foreign-thread'));
    await new Promise((r) => setTimeout(r, 100));
    expect(mocks.openForThread).not.toHaveBeenCalled();
  });

  test('disabled by FUNNY_BROWSER_TOOLS=0', async () => {
    process.env.FUNNY_BROWSER_TOOLS = '0';
    expect(await browserOpenEnv('u1', 'own-thread')).toEqual({});
    delete process.env.FUNNY_BROWSER_TOOLS;
  });
});
