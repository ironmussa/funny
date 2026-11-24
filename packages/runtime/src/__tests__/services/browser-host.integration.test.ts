/**
 * BrowserHost against a real headless Chromium: persistent tabs share a
 * profile, ephemeral tabs are isolated, and the user agent is regular Chrome.
 * Skipped when no Playwright Chromium is installed on the machine.
 */

import { afterAll, beforeAll, describe, expect, test, vi, mock } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { Result } from 'neverthrow';

mock.module('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  BrowserHost,
  resolveChromiumBinary,
} from '../../services/browser-automation/browser-host.js';

/** Value of an Ok result; fails the test with the error otherwise. */
function unwrap<T, E>(result: Result<T, E>): T {
  if (result.isErr()) throw new Error(`Expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

const binary = await resolveChromiumBinary().catch(() => null);
const describeWithChromium = binary && existsSync(binary) ? describe : describe.skip;
/** The suites below only run when `binary` resolved, so the fallback is never launched. */
const chromiumBinary = binary ?? '';

describeWithChromium('BrowserHost (real Chromium)', () => {
  let profileDir: string;
  let host: BrowserHost;

  beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'funny-host-test-'));
    const result = await BrowserHost.launch({
      binary: chromiumBinary,
      profileDir: join(profileDir, 'default'),
      port: 9390 + Math.floor(Math.random() * 50),
      windowWidth: 800,
      windowHeight: 600,
      onExit: () => {},
    });
    if (result.isErr()) throw result.error;
    host = result.value;
  }, 60_000);

  afterAll(async () => {
    await host?.shutdown();
    rmSync(profileDir, { recursive: true, force: true });
  });

  test('persistent tabs share storage; ephemeral tabs do not', async () => {
    const a = unwrap(await host.newTab('persistent'));
    const b = unwrap(await host.newTab('persistent'));
    const eph = unwrap(await host.newTab('ephemeral'));
    const origin = 'https://example.invalid/';
    for (const tab of [a, b, eph]) {
      await tab.page.route('**/*', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<p>ok</p>' }),
      );
      await tab.page.goto(origin);
    }
    await a.page.evaluate(() => localStorage.setItem('k', 'shared'));

    expect(await b.page.evaluate(() => localStorage.getItem('k'))).toBe('shared');
    expect(await eph.page.evaluate(() => localStorage.getItem('k'))).toBeNull();
    expect(a.targetId).not.toBe(b.targetId);

    for (const tab of [a, b, eph]) await host.closeTab(tab);
  }, 30_000);

  test('reports a regular Chrome user agent', async () => {
    const tab = unwrap(await host.newTab('persistent'));
    const ua = await tab.page.evaluate(() => navigator.userAgent);
    expect(ua).not.toContain('HeadlessChrome');
    expect(ua).toMatch(/Chrome\/\d+\.0\.0\.0/);
    await host.closeTab(tab);
  }, 30_000);

  test('pages can create a WebGL context', async () => {
    const tab = unwrap(await host.newTab('persistent'));
    const webgl = await tab.page.evaluate(() => {
      const canvas = document.createElement('canvas');
      return !!canvas.getContext('webgl');
    });
    expect(webgl).toBe(true);
    await host.closeTab(tab);
  }, 30_000);
});

describeWithChromium('BrowserHost after an abrupt stop (real Chromium)', () => {
  test('tabs of the last run are not restored', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'funny-host-restore-'));
    const launch = async () =>
      unwrap(
        await BrowserHost.launch({
          binary: chromiumBinary,
          profileDir: join(profileDir, 'default'),
          port: 9440 + Math.floor(Math.random() * 50),
          windowWidth: 800,
          windowHeight: 600,
          onExit: () => {},
        }),
      );
    try {
      const first = await launch();
      const tab = unwrap(await first.newTab('persistent'));
      await tab.page.goto('data:text/html,<title>left over</title>');
      // Let Chromium write its session file, then stop it the way a runner
      // restart does: no clean shutdown.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      // `proc` and `exited` are private: kill the process the way a crash would.
      first['proc'].kill('SIGKILL');
      await first['exited'];

      const second = await launch();
      // Give a session restore time to open its tabs.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const urls = second.browser
        .contexts()[0]!
        .pages()
        .map((page) => page.url());
      expect(urls.filter((url) => url !== 'about:blank')).toEqual([]);
      await second.shutdown();
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  }, 90_000);
});
