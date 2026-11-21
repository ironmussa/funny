import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { changedFiles, testCheckout } from '../pre-push';
import { testSuiteEnv } from '../test-env';

const ZERO = '0'.repeat(40);
let repo: string;

function git(...args: string[]): string {
  // Strip GIT_DIR & co. so a run from inside a git hook stays in the temp repo.
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: testSuiteEnv(process.env),
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function commit(file: string): string {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), `${file}\n`);
  git('add', '.');
  git('commit', '-q', '-m', file);
  return git('rev-parse', 'HEAD');
}

const refLine = (local: string, remote: string) => `refs/heads/x ${local} refs/heads/x ${remote}\n`;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'pre-push-'));
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test('an existing branch only contributes the commits being added', () => {
  const remote = commit('packages/a/old.ts');
  const local = commit('packages/b/new.ts');
  expect(changedFiles(refLine(local, remote), repo)).toEqual(['packages/b/new.ts']);
});

test('a new branch is measured from its merge base with the default branch', () => {
  const base = commit('packages/a/base.ts');
  git('checkout', '-q', '-b', 'feature');
  const local = commit('packages/b/feature.ts');
  expect(changedFiles(refLine(local, ZERO), repo, base)).toEqual(['packages/b/feature.ts']);
});

test('deletions and blank lines add nothing', () => {
  const sha = commit('packages/a/a.ts');
  expect(changedFiles(`${refLine(ZERO, sha)}\n`, repo)).toEqual([]);
});

test('an unresolvable range returns null so the caller runs everything', () => {
  const local = commit('packages/a/a.ts');
  expect(changedFiles(refLine(local, ZERO), repo, 'no-such-ref')).toBeNull();
});

// The suites must test what is pushed, not the checkout's files: a shared
// checkout may hold another agent's unfinished edits (a source changed before
// its test), which failed pushes that did not touch them.
const noInstall = () => true;

test('a clean checkout at the pushed commit is tested in place', () => {
  const head = commit('packages/a/a.ts');
  const checkout = testCheckout([head], repo, noInstall);
  expect(checkout.root).toBe(repo);
  expect(checkout.warning).toBeUndefined();
});

test('uncommitted edits send the suites to a worktree of the pushed commit', () => {
  const head = commit('packages/a/a.ts');
  writeFileSync(join(repo, 'packages/a/a.ts'), 'half-done edit\n');
  const checkout = testCheckout([head], repo, noInstall);
  try {
    expect(checkout.root).not.toBe(repo);
    expect(readFileSync(join(checkout.root, 'packages/a/a.ts'), 'utf8')).toBe('packages/a/a.ts\n');
  } finally {
    checkout.dispose();
  }
  expect(existsSync(checkout.root)).toBe(false);
  expect(git('worktree', 'list')).not.toContain(checkout.root);
});

test('a pushed commit other than HEAD is tested at that commit', () => {
  const pushed = commit('packages/a/a.ts');
  commit('packages/b/b.ts');
  const checkout = testCheckout([pushed], repo, noInstall);
  try {
    expect(existsSync(join(checkout.root, 'packages/a/a.ts'))).toBe(true);
    expect(existsSync(join(checkout.root, 'packages/b/b.ts'))).toBe(false);
  } finally {
    checkout.dispose();
  }
});

test('a failed install falls back to the checkout and says so', () => {
  const head = commit('packages/a/a.ts');
  writeFileSync(join(repo, 'packages/a/a.ts'), 'edit\n');
  const checkout = testCheckout([head], repo, () => false);
  expect(checkout.root).toBe(repo);
  expect(checkout.warning).toContain('could not prepare');
  expect(git('worktree', 'list').split('\n')).toHaveLength(1);
});
