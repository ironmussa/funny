/**
 * BrowserHost against a real headless Chromium: persistent tabs share a
 * profile, ephemeral tabs are isolated, and the user agent is regular Chrome.
 * Skipped when no Playwright Chromium is installed on the machine.
 */

import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { Result } from 'neverthrow';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
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

describeWithChromium('BrowserHost (real Chromium)', () => {
  let profileDir: string;
  let host: BrowserHost;

  beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'funny-host-test-'));
    const result = await BrowserHost.launch({
      binary: binary as string,
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
});
