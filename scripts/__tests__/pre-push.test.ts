import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { changedFiles } from '../pre-push';
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
