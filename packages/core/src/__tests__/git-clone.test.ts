/**
 * Regression (#181): the clone used to put the GitHub token in the clone URL,
 * so it showed up in the `git clone` argv (`ps`) and in `.git/config`. The
 * token now travels in git's environment as an Authorization header scoped to
 * https://github.com/, and the clone goes through the network pool with a
 * timeout and cancellation.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, test } from 'vitest';

import { cloneAuthEnv, cloneRepository } from '../git/clone.js';
import { execute, executeSync } from '../git/process.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function sourceRepo(): string {
  const dir = tempDir('funny-clone-src-');
  executeSync('git', ['init', '-q'], { cwd: dir });
  executeSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: dir },
  );
  return dir;
}

describe('cloneAuthEnv', () => {
  test('scopes the token to https://github.com/ as an Authorization header', () => {
    const env = cloneAuthEnv('https://github.com/acme/widget.git', 'ghp_secret');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from('x-access-token:ghp_secret').toString('base64')}`,
    );
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  test('never sends the GitHub token to another host', () => {
    for (const url of ['https://gitlab.com/acme/widget.git', 'https://github.com.evil.io/x.git']) {
      const env = cloneAuthEnv(url, 'ghp_secret');
      expect(JSON.stringify(env)).not.toContain(Buffer.from('ghp_secret').toString('base64'));
      expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    }
  });

  test('adds no credential without a token', () => {
    expect(cloneAuthEnv('https://github.com/acme/widget.git', null)).toEqual({
      GIT_TERMINAL_PROMPT: '0',
    });
  });
});

describe('cloneRepository', () => {
  test('clones and reports git progress lines', async () => {
    const source = sourceRepo();
    const destination = join(tempDir('funny-clone-dst-'), 'widget');
    const lines: string[] = [];

    const result = await cloneRepository(source, destination, {
      githubToken: 'ghp_secret',
      onProgress: (line) => lines.push(line),
    });

    expect(result.isOk()).toBe(true);
    expect(existsSync(join(destination, '.git'))).toBe(true);
    expect(lines.some((line) => /Cloning into/.test(line))).toBe(true);
    expect(readFileSync(join(destination, '.git', 'config'), 'utf8')).not.toContain('ghp_secret');
  });

  test('answers a process error with git stderr when the clone fails', async () => {
    const destination = join(tempDir('funny-clone-dst-'), 'missing');
    const result = await cloneRepository(join(tmpdir(), 'funny-no-such-repo'), destination);

    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error.message).toMatch(/does not exist|not appear/);
  });

  test('stops the clone when cancelled', async () => {
    const source = sourceRepo();
    const destination = join(tempDir('funny-clone-dst-'), 'widget');
    const controller = new AbortController();
    controller.abort();

    const result = await cloneRepository(source, destination, { signal: controller.signal });

    expect(result.isErr()).toBe(true);
  });
});

describe('ProcessOptions.onStderr', () => {
  test('streams stderr chunks while the process runs', async () => {
    const chunks: string[] = [];
    await execute('sh', ['-c', 'echo one >&2; echo two >&2'], {
      onStderr: (chunk) => chunks.push(chunk),
    });
    expect(chunks.join('')).toBe('one\ntwo\n');
  });
});
