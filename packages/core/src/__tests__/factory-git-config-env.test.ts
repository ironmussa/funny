/**
 * The issue factory's git configuration (openspec factory-integration 3.1):
 * rerere (and weave, when installed) reach git through GIT_CONFIG_* in the
 * environment of a merge in a linked worktree, and nothing is written to the
 * repository the user's own checkout shares.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { factoryGitConfigEnv } from '../git/weave.js';

let root: string;

const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-git-env-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('factoryGitConfigEnv', () => {
  test('a merge in a linked worktree records with rerere and leaves the main checkout alone', async () => {
    const main = join(root, 'main');
    git(root, ['init', '-q', '-b', 'main', main]);
    writeFileSync(join(main, 'a.txt'), 'one\ntwo\nthree\n');
    git(main, ['add', '-A']);
    git(main, ['commit', '-q', '-m', 'base']);
    const configBefore = readFileSync(join(main, '.git', 'config'), 'utf8');

    const worktree = join(root, 'wt');
    git(main, ['worktree', 'add', '-q', '-b', 'feature', worktree]);
    writeFileSync(join(worktree, 'a.txt'), 'one\nFEATURE\nthree\n');
    git(worktree, ['commit', '-q', '-am', 'feature']);
    writeFileSync(join(main, 'a.txt'), 'one\nBASE\nthree\n');
    git(main, ['commit', '-q', '-am', 'base edit']);

    const prepared = await factoryGitConfigEnv(join(root, 'factory-git'));
    const { env } = prepared._unsafeUnwrap();
    expect(env.GIT_CONFIG_COUNT).toBeDefined();
    try {
      git(worktree, ['merge', '--no-edit', 'main'], { ...env, HOME: root });
    } catch {
      // The conflict is expected: rerere records its preimage.
    }
    expect(existsSync(join(main, '.git', 'rr-cache'))).toBe(true);
    expect(readFileSync(join(main, '.git', 'config'), 'utf8')).toBe(configBefore);
    expect(existsSync(join(main, '.git', 'info', 'attributes'))).toBe(false);
  });

  test('without the variables, the same merge records nothing', () => {
    const repo = join(root, 'plain');
    git(root, ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    git(repo, ['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(repo, 'a.txt'), 'feature\n');
    git(repo, ['commit', '-q', '-am', 'f']);
    git(repo, ['checkout', '-q', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git(repo, ['commit', '-q', '-am', 'b']);
    try {
      git(repo, ['merge', '--no-edit', 'feature'], { HOME: root });
    } catch {
      // expected conflict
    }
    expect(existsSync(join(repo, '.git', 'rr-cache'))).toBe(false);
  });
});
