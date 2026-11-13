import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GITHUB_APP_TOKEN_REUSE_MARGIN_MS } from '@funny/shared/github-app-token';
import { afterEach, describe, expect, test } from 'vitest';

import {
  createSandboxGithubAuth,
  renewalDelay,
  type GithubAppTokenReply,
} from '../../services/sandbox-github-auth.js';

const homes: string[] = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});
const tempHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'funny-sandbox-gh-'));
  homes.push(dir);
  return dir;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reply = (n: number, expiresAt = '2026-11-10T13:00:00Z'): GithubAppTokenReply => ({
  token: `ghs_${n}`,
  expiresAt,
  repo: 'acme/app',
});
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const MIN = 60_000;

describe('renewalDelay', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const expiringIn = (ms: number) => new Date(now + ms).toISOString();

  test('renews 5 minutes before the token expires', () => {
    expect(renewalDelay(expiringIn(60 * MIN), now)).toBe(55 * MIN);
  });

  // #184: the server hands back its cached token until shortly before expiry.
  // A renewal asked earlier than that got the same token and the sandbox ran
  // on an expired one; it must ask once the server will mint a new token.
  test('asks only when the server no longer reuses the token, and before it expires', () => {
    for (const lifetime of [60 * MIN, 30 * MIN, 12 * MIN]) {
      const left = lifetime - renewalDelay(expiringIn(lifetime), now);
      expect(left).toBeLessThan(GITHUB_APP_TOKEN_REUSE_MARGIN_MS);
      expect(left).toBeGreaterThan(0);
    }
  });

  test('waits at least 30 seconds when the token is about to expire', () => {
    expect(renewalDelay(expiringIn(2 * MIN), now)).toBe(30_000);
  });

  test('retries in 45 minutes without a valid token', () => {
    expect(renewalDelay(null, now)).toBe(45 * MIN);
    expect(renewalDelay(expiringIn(-MIN), now)).toBe(45 * MIN);
    expect(renewalDelay('not a date', now)).toBe(45 * MIN);
  });
});

describe('sandbox GitHub auth', () => {
  test('writes the token where gh reads it (0600) and points git at gh, in the real git config', async () => {
    const home = tempHome();
    const auth = createSandboxGithubAuth({ homeDir: home, fetchToken: async () => reply(1) });
    const token = await auth.ensure('t-1');
    expect(token.isOk() && token.value.repo).toBe('acme/app');

    const hosts = join(home, '.config', 'gh', 'hosts.yml');
    expect(readFileSync(hosts, 'utf8')).toContain('oauth_token: ghs_1');
    expect(statSync(hosts).mode & 0o777).toBe(0o600);

    const helpers = execFileSync(
      'git',
      ['config', '--global', '--get-all', 'credential.https://github.com.helper'],
      { env: { ...process.env, HOME: home }, encoding: 'utf8' },
    );
    expect(helpers.split('\n')).toEqual(['', '!gh auth git-credential', '']);
  });

  const hasGh = (() => {
    try {
      execFileSync('gh', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  test.skipIf(!hasGh)('real gh and git hand out the App token', async () => {
    const home = tempHome();
    const auth = createSandboxGithubAuth({ homeDir: home, fetchToken: async () => reply(7) });
    expect((await auth.ensure('t-1')).isOk()).toBe(true);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
    expect(execFileSync('gh', ['auth', 'token'], { env, encoding: 'utf8' }).trim()).toBe('ghs_7');
    const fill = execFileSync('git', ['credential', 'fill'], {
      env,
      encoding: 'utf8',
      input: 'protocol=https\nhost=github.com\n\n',
    });
    expect(fill).toContain('password=ghs_7');
  });

  test('a refusal from the server installs nothing', async () => {
    const home = tempHome();
    const auth = createSandboxGithubAuth({
      homeDir: home,
      fetchToken: async () => ({
        error: 'not-installed',
        message: 'App not installed on acme/app',
      }),
    });
    const token = await auth.ensure('t-1');
    expect(token.isErr() && token.error).toBe('App not installed on acme/app');
    expect(() => statSync(join(home, '.config', 'gh', 'hosts.yml'))).toThrow();
  });

  const fast = { renewBeforeExpiryMs: 30, minDelayMs: 5 };

  test('renews each token shortly before it expires, until stopped', async () => {
    let n = 0;
    const home = tempHome();
    const auth = createSandboxGithubAuth({
      homeDir: home,
      configureGit: async () => (await import('neverthrow')).ok(undefined),
      // Every token lives 50 ms, so it is renewed about every 20 ms.
      fetchToken: async () => reply(++n, inMs(50)),
      ...fast,
    });
    auth.startRefresh('t-1', inMs(50));
    await sleep(200);
    await auth.stop();
    const renewals = n;
    expect(renewals).toBeGreaterThanOrEqual(3);
    expect(readFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'utf8')).toContain(
      `ghs_${renewals}`,
    );
    await sleep(60);
    expect(n).toBe(renewals);
  });

  test('does not renew a token that is far from expiring', async () => {
    let n = 0;
    const auth = createSandboxGithubAuth({
      homeDir: tempHome(),
      fetchToken: async () => reply(++n, inMs(60 * MIN)),
      ...fast,
    });
    auth.startRefresh('t-1', inMs(60 * MIN));
    await sleep(60);
    await auth.stop();
    expect(n).toBe(0);
  });

  test('after a failed renewal, renews again before the held token expires', async () => {
    let calls = 0;
    const auth = createSandboxGithubAuth({
      homeDir: tempHome(),
      fetchToken: async () => {
        calls++;
        throw new Error('server unreachable');
      },
      // Still valid for an hour, but already inside the renewal window: the
      // floor, not the 45-minute failure wait, sets the next round.
      renewBeforeExpiryMs: 2 * 60 * MIN,
      minDelayMs: 5,
      retryBaseMs: 1,
    });
    auth.startRefresh('t-1', inMs(60 * MIN));
    await sleep(200);
    await auth.stop();
    // More than one round of a first try plus five retries.
    expect(calls).toBeGreaterThan(6);
  });

  test('retries a failed renewal with backoff and keeps trying without a token', async () => {
    let calls = 0;
    const auth = createSandboxGithubAuth({
      homeDir: tempHome(),
      fetchToken: async () => {
        calls++;
        throw new Error('server unreachable');
      },
      retryAfterFailureMs: 10,
      retryBaseMs: 1,
    });
    auth.startRefresh('t-1', null);
    await sleep(150);
    await auth.stop();
    // At least one full round: the first try plus five retries.
    expect(calls).toBeGreaterThanOrEqual(6);
  });

  test('stopping during the backoff stops the retries', async () => {
    let calls = 0;
    const auth = createSandboxGithubAuth({
      homeDir: tempHome(),
      fetchToken: async () => {
        calls++;
        throw new Error('server unreachable');
      },
      retryAfterFailureMs: 1,
      retryBaseMs: 200,
    });
    auth.startRefresh('t-1', null);
    await sleep(50);
    await auth.stop();
    const atStop = calls;
    await sleep(400);
    expect(calls).toBe(atStop);
  });
});
