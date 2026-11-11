import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  checkoutProjectIntoSandbox,
  runSandboxPostCreate,
} from '../../services/sandbox-checkout.js';
import { redactGithubToken, withGithubToken } from '../../utils/github-clone-url.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'funny-sandbox-checkout-'));
  dirs.push(dir);
  return dir;
};

const REPO = 'https://github.com/ironmussa/funny.git';

describe('checkoutProjectIntoSandbox', () => {
  test('reuses an existing checkout without cloning', async () => {
    const path = tempDir();
    mkdirSync(join(path, '.git'));
    const result = await checkoutProjectIntoSandbox({ path, repoUrl: REPO, token: null });
    // An empty `.git` is not a readable repository, so its branch is unknown.
    expect(result.isOk() && result.value).toEqual({ path, cloned: false, branch: null });
  });

  test('does not rerun postCreate on an existing checkout', async () => {
    const path = tempDir();
    mkdirSync(join(path, '.git'));
    writeFileSync(join(path, '.funny.json'), JSON.stringify({ postCreate: ['touch ran'] }));
    await checkoutProjectIntoSandbox({ path, repoUrl: REPO, token: null });
    expect(existsSync(join(path, 'ran'))).toBe(false);
  });

  test('refuses to clone over a non-empty directory that is not a checkout', async () => {
    const path = tempDir();
    writeFileSync(join(path, 'notes.txt'), 'hello');
    const result = await checkoutProjectIntoSandbox({ path, repoUrl: REPO, token: null });
    expect(result.isErr() && result.error.type).toBe('CONFLICT');
  });

  test('rejects relative paths and non-repository URLs', async () => {
    const relative = await checkoutProjectIntoSandbox({
      path: 'work/repo',
      repoUrl: REPO,
      token: null,
    });
    expect(relative.isErr() && relative.error.type).toBe('BAD_REQUEST');
    for (const repoUrl of ['file:///etc', 'https://evil.example/x y', '--upload-pack=sh']) {
      const result = await checkoutProjectIntoSandbox({ path: tempDir(), repoUrl, token: null });
      expect(result.isErr() && result.error.type).toBe('BAD_REQUEST');
    }
  });
});

describe('checkoutProjectIntoSandbox branch', () => {
  test('rejects branch names that could be read as options or revisions', async () => {
    for (const branch of ['--upload-pack=sh', '-b', 'a b', 'main~1', 'x:y']) {
      const result = await checkoutProjectIntoSandbox({
        path: tempDir(),
        repoUrl: REPO,
        token: null,
        branch,
      });
      expect(result.isErr() && result.error.type).toBe('BAD_REQUEST');
    }
  });
});

describe('runSandboxPostCreate', () => {
  test('runs the postCreate commands in order inside the checkout', async () => {
    const path = tempDir();
    const postCreate = ['echo one > log', 'false', 'echo two >> log'];
    writeFileSync(join(path, '.funny.json'), JSON.stringify({ postCreate }));
    const errors = await runSandboxPostCreate(path);
    expect(readFileSync(join(path, 'log'), 'utf8')).toBe('one\ntwo\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"false"');
  });

  test('is a no-op without a .funny.json', async () => {
    expect(await runSandboxPostCreate(tempDir())).toEqual([]);
  });
});

describe('GitHub clone URL credentials', () => {
  test('injects the token only into github.com https URLs and redacts it', () => {
    const token = 'ghp_secret';
    const url = withGithubToken(REPO, token);
    expect(url).toBe(`https://x-access-token:${token}@github.com/ironmussa/funny.git`);
    expect(withGithubToken('https://gitlab.com/a/b.git', token)).toBe('https://gitlab.com/a/b.git');
    expect(withGithubToken(REPO, null)).toBe(REPO);
    expect(redactGithubToken(`fatal: could not read ${url}`)).toBe(
      'fatal: could not read https://x-access-token:***@github.com/ironmussa/funny.git',
    );
  });
});
