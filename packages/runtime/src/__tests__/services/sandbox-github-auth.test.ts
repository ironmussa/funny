import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  createSandboxGithubAuth,
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
const reply = (n: number): GithubAppTokenReply => ({
  token: `ghs_${n}`,
  expiresAt: '2026-11-10T13:00:00Z',
  repo: 'acme/app',
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

  test('renews the token on schedule until stopped', async () => {
    let n = 0;
    const home = tempHome();
    const auth = createSandboxGithubAuth({
      homeDir: home,
      configureGit: async () => (await import('neverthrow')).ok(undefined),
      fetchToken: async () => reply(++n),
      refreshEveryMs: 20,
    });
    auth.startRefresh('t-1');
    await sleep(110);
    await auth.stop();
    const renewals = n;
    expect(renewals).toBeGreaterThanOrEqual(3);
    expect(readFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'utf8')).toContain(
      `ghs_${renewals}`,
    );
    await sleep(60);
    expect(n).toBe(renewals);
  });

  test('retries a failed renewal with backoff, gives up after the retries, and keeps the schedule', async () => {
    let calls = 0;
    const auth = createSandboxGithubAuth({
      homeDir: tempHome(),
      fetchToken: async () => {
        calls++;
        throw new Error('server unreachable');
      },
      refreshEveryMs: 10,
      retryBaseMs: 1,
    });
    auth.startRefresh('t-1');
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
      refreshEveryMs: 1,
      retryBaseMs: 200,
    });
    auth.startRefresh('t-1');
    await sleep(50);
    await auth.stop();
    const atStop = calls;
    await sleep(400);
    expect(calls).toBe(atStop);
  });
});
