import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { err, ok } from 'neverthrow';
import { afterEach, describe, expect, test } from 'vitest';

import {
  createGithubTokenWriter,
  createInstallationTokenIssuer,
  ghCredentialHelper,
} from '../github-app/index.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const app = { appId: '5690396', privateKey };

describe('installation token issuer', () => {
  function setup(installed = true) {
    let clock = Date.parse('2026-11-10T12:00:00Z');
    const calls: Array<{ url: string; auth: string; body?: any }> = [];
    let minted = 0;
    const fetchFake = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({
        url,
        auth: headers.authorization,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status });
      if (url.endsWith('/repos/acme/app/installation'))
        return installed ? json(200, { id: 99 }) : json(404, {});
      if (url.endsWith('/app/installations/99/access_tokens')) {
        minted++;
        return json(201, {
          token: `ghs_${minted}`,
          expires_at: new Date(clock + 60 * 60 * 1000).toISOString(),
        });
      }
      return json(500, {});
    }) as unknown as typeof fetch;
    const issuer = createInstallationTokenIssuer({
      fetch: fetchFake,
      api: 'https://api.example',
      now: () => new Date(clock),
    });
    return { issuer, calls, advance: (ms: number) => (clock += ms) };
  }

  test('mints a token for exactly one repository and the asked permissions, with the App JWT', async () => {
    const { issuer, calls } = setup();
    const permissions = { contents: 'write', pull_requests: 'write', metadata: 'read' } as const;
    const token = (await issuer.issue({ app, repo: 'Acme/App', permissions }))._unsafeUnwrap();
    expect(token).toEqual({ token: 'ghs_1', expiresAt: expect.any(String), repo: 'acme/app' });
    const mint = calls.find((c) => c.url.endsWith('/access_tokens'))!;
    expect(mint.body).toEqual({ repositories: ['app'], permissions });
    expect(mint.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.stringify(token)).not.toContain('PRIVATE KEY');
  });

  test('reuses a token per permission set until ten minutes before it expires', async () => {
    const { issuer, advance } = setup();
    const write = { contents: 'write' } as const;
    const read = { contents: 'read' } as const;
    const token = async (permissions: Record<string, 'read' | 'write'>) =>
      (await issuer.issue({ app, repo: 'acme/app', permissions }))._unsafeUnwrap().token;
    expect(await token(write)).toBe('ghs_1');
    expect(await token(read)).toBe('ghs_2');
    advance(45 * 60 * 1000);
    expect(await token(write)).toBe('ghs_1');
    advance(6 * 60 * 1000);
    expect(await token(write)).toBe('ghs_3');
  });

  test('a repository without the App installed, and a bad key', async () => {
    const { issuer } = setup(false);
    const permissions = { contents: 'read' } as const;
    expect(
      (await issuer.issue({ app, repo: 'acme/app', permissions }))._unsafeUnwrapErr().kind,
    ).toBe('not-installed');
    const badKey = { appId: '1', privateKey: 'not a key' };
    expect(
      (
        await setup().issuer.issue({ app: badKey, repo: 'acme/app', permissions })
      )._unsafeUnwrapErr().kind,
    ).toBe('not-configured');
  });
});

describe('GitHub token writer with a caller-chosen gh config directory', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'funny-token-writer-'));
    dirs.push(dir);
    return dir;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("writes gh's hosts.yml and git's helper there, leaving the home untouched", async () => {
    const home = temp();
    const run = temp();
    const ghConfigDir = join(run, "gh config's");
    const gitConfigFile = join(run, 'gitconfig');
    const writer = createGithubTokenWriter<string>({
      homeDir: home,
      ghConfigDir,
      gitConfigFile,
      fetchToken: async () =>
        ok({ token: 'ghs_9', expiresAt: '2026-11-10T13:00:00Z', repo: 'a/b' }),
    });
    expect((await writer.ensure('run-1'))._unsafeUnwrap().token).toBe('ghs_9');

    const hosts = join(ghConfigDir, 'hosts.yml');
    expect(readFileSync(hosts, 'utf8')).toContain('oauth_token: ghs_9');
    expect(statSync(hosts).mode & 0o777).toBe(0o600);
    const helpers = execFileSync(
      'git',
      ['config', '--file', gitConfigFile, '--get-all', 'credential.https://github.com.helper'],
      { encoding: 'utf8' },
    );
    expect(helpers.split('\n')).toEqual(['', ghCredentialHelper(ghConfigDir), '']);
    expect(existsSync(join(home, '.config', 'gh'))).toBe(false);
    expect(existsSync(join(home, '.gitconfig'))).toBe(false);
  });

  test('the helper runs gh with the chosen directory, shell-quoted', () => {
    expect(ghCredentialHelper()).toBe('!gh auth git-credential');
    expect(ghCredentialHelper("/tmp/it's")).toBe(
      "!GH_CONFIG_DIR='/tmp/it'\\''s' gh auth git-credential",
    );
  });

  test('renews for the key it was started with and reports failed renewals', async () => {
    const ghConfigDir = temp();
    const asked: string[] = [];
    const failures: string[] = [];
    let n = 0;
    const writer = createGithubTokenWriter<string>({
      ghConfigDir,
      configureGit: async () => ok(undefined),
      renewBeforeExpiryMs: 30,
      minDelayMs: 5,
      retryAfterFailureMs: 10_000,
      retryBaseMs: 1,
      fetchToken: async (key) => {
        asked.push(key);
        n++;
        return n <= 2
          ? ok({
              token: `ghs_${n}`,
              expiresAt: new Date(Date.now() + 60).toISOString(),
              repo: 'a/b',
            })
          : err('App not installed');
      },
      onRenewalFailed: (key) => failures.push(key),
    });
    const first = (await writer.ensure('run-1'))._unsafeUnwrap();
    writer.startRefresh('run-1', first.expiresAt);
    await sleep(200);
    await writer.stop();
    expect(new Set(asked)).toEqual(new Set(['run-1']));
    expect(readFileSync(join(ghConfigDir, 'hosts.yml'), 'utf8')).toContain('ghs_2');
    expect(failures).toEqual(['run-1']);
  });
});

describe('GitHub token writer with an injected clock', () => {
  test('renews only once the clock passes the renewal time', async () => {
    let now = Date.parse('2026-11-10T12:00:00Z');
    const sleepers: Array<{ at: number; wake: () => void }> = [];
    const clock = {
      now: () => now,
      sleep: (ms: number) => new Promise<void>((wake) => sleepers.push({ at: now + ms, wake })),
    };
    const advance = (ms: number) => {
      now += ms;
      for (const s of sleepers.splice(0)) {
        if (s.at <= now) s.wake();
        else sleepers.push(s);
      }
    };
    const dir = mkdtempSync(join(tmpdir(), 'funny-token-clock-'));
    let n = 0;
    const writer = createGithubTokenWriter<string>({
      ghConfigDir: dir,
      configureGit: async () => ok(undefined),
      clock,
      fetchToken: async () =>
        ok({
          token: `ghs_${++n}`,
          expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
          repo: 'a/b',
        }),
    });
    const hosts = () => readFileSync(join(dir, 'hosts.yml'), 'utf8');
    const first = (await writer.ensure('run-1'))._unsafeUnwrap();
    writer.startRefresh('run-1', first.expiresAt);
    await new Promise((r) => setTimeout(r, 20));
    expect(hosts()).toContain('ghs_1');

    advance(50 * 60 * 1000);
    await new Promise((r) => setTimeout(r, 20));
    expect(hosts()).toContain('ghs_1');

    advance(6 * 60 * 1000);
    for (let i = 0; i < 50 && !hosts().includes('ghs_2'); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(hosts()).toContain('ghs_2');
    await writer.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
