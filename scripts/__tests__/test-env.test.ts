import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { testSuiteEnv } from '../test-env';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'funny-test-env-'));
  dirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string, env: Record<string, string | undefined>): string {
  const proc = Bun.spawnSync(['git', ...args], { cwd, env: env as Record<string, string> });
  return proc.stdout.toString().trim();
}

/** What a test suite does: a throwaway repo with one commit. */
function commitInFreshRepo(cwd: string, env: Record<string, string | undefined>) {
  git(['init', '-q'], cwd, env);
  git(['config', 'user.name', 'Test'], cwd, env);
  git(['config', 'user.email', 'test@test.com'], cwd, env);
  writeFileSync(join(cwd, 'file.txt'), 'x');
  git(['add', '.'], cwd, env);
  git(['commit', '-q', '-m', 'initial commit'], cwd, env);
}

/** A repository standing in for the shared `.git` of a worktree checkout. */
function decoyRepo(): { gitDir: string; head: string } {
  const dir = tempDir();
  const env = testSuiteEnv(process.env);
  git(['init', '-q'], dir, env);
  git(
    [
      '-c',
      'user.name=Owner',
      '-c',
      'user.email=o@o',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'owner',
    ],
    dir,
    env,
  );
  return { gitDir: join(dir, '.git'), head: git(['rev-parse', 'HEAD'], dir, env) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('testSuiteEnv', () => {
  test('a hook-exported GIT_DIR redirects test git commands into the real repo', () => {
    const decoy = decoyRepo();
    const hookEnv = { ...process.env, GIT_DIR: decoy.gitDir };

    commitInFreshRepo(tempDir(), hookEnv);

    expect(
      git(['--git-dir', decoy.gitDir, 'rev-parse', 'HEAD'], '/', testSuiteEnv(process.env)),
    ).not.toBe(decoy.head);
  });

  test('suites run without the variables keep their git work in their own repo', () => {
    const decoy = decoyRepo();
    const hookEnv = {
      ...process.env,
      GIT_DIR: decoy.gitDir,
      GIT_INDEX_FILE: join(decoy.gitDir, 'index'),
    };
    const repo = tempDir();

    commitInFreshRepo(repo, testSuiteEnv(hookEnv));

    const cleanEnv = testSuiteEnv(process.env);
    expect(git(['--git-dir', decoy.gitDir, 'rev-parse', 'HEAD'], '/', cleanEnv)).toBe(decoy.head);
    expect(git(['--git-dir', decoy.gitDir, 'config', '--get', 'core.bare'], '/', cleanEnv)).toBe(
      'false',
    );
    expect(existsSync(join(repo, '.git'))).toBe(true);
    expect(git(['log', '--format=%s'], repo, cleanEnv)).toBe('initial commit');
  });

  test('drops every repository-local variable and keeps the rest', () => {
    const env = testSuiteEnv({
      PATH: '/bin',
      GIT_EDITOR: 'true',
      GIT_DIR: '/x/.git',
      GIT_WORK_TREE: '/x',
      GIT_COMMON_DIR: '/x/.git',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.bare',
      GIT_CONFIG_VALUE_0: 'true',
    });
    expect(env).toEqual({ PATH: '/bin', GIT_EDITOR: 'true' });
  });
});
