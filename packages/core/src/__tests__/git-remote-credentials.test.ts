/**
 * sandbox-git-credential-broker: a sandbox runner gets no GitHub token, so
 * `gitRemote` must then add no credential of its own and leave git to the
 * checkout's credential helper (the broker's), instead of shadowing it.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, test } from 'vitest';

import { gitRemote } from '../git/index.js';
import { executeSync } from '../git/process.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repoWithCredentialHelper(): string {
  const dir = mkdtempSync(join(tmpdir(), 'funny-git-remote-cred-'));
  dirs.push(dir);
  executeSync('git', ['init', '-q'], { cwd: dir });
  executeSync('git', ['config', 'credential.helper', 'broker-helper'], { cwd: dir });
  return dir;
}

const config = async (dir: string, key: string, githubToken?: string) => {
  const result = await gitRemote(
    ['config', '--get-all', key],
    dir,
    githubToken ? { githubToken } : undefined,
  );
  return result.isOk() ? result.value.trim() : null;
};

describe('gitRemote credentials', () => {
  test('without a token it adds no auth header and keeps the checkout credential helper', async () => {
    const dir = repoWithCredentialHelper();
    expect(await config(dir, 'http.extraHeader')).toBeNull();
    const helper = await gitRemote(['config', '--local', '--get-all', 'credential.helper'], dir);
    expect(helper.isOk() && helper.value.trim()).toBe('broker-helper');
  });

  test('with a token it adds the GitHub auth header', async () => {
    const dir = repoWithCredentialHelper();
    expect(await config(dir, 'http.extraHeader', 'ghp_test')).toContain('Authorization: Basic');
  });
});
