import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { fetchRemote } from '../git/branch.js';
import { executeSync, getGitWriteGeneration, gitNetwork, gitWrite } from '../git/process.js';

const TMP = resolve(tmpdir(), 'core-git-pools-' + process.pid + '-' + Date.now());
const LOG = resolve(TMP, 'order.log');

/** A git command that sleeps, then appends `label` to the shared order log. */
function slow(label: string, seconds: number): string[] {
  return ['-c', `alias.mark=!sleep ${seconds} && echo ${label} >> '${LOG}'`, 'mark'];
}

function order(): string[] {
  return readFileSync(LOG, 'utf8').trim().split('\n');
}

function repo(name: string): string {
  const path = resolve(TMP, name);
  mkdirSync(path, { recursive: true });
  executeSync('git', ['init', '-q', '-b', 'master'], { cwd: path });
  return path;
}

describe('git process pools', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(LOG, '');
  });
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  test('slow network commands do not hold up local writes', async () => {
    const a = repo('a');
    // Fill every network slot (and more) with slow "pushes".
    const network = Array.from({ length: 5 }, (_, i) => gitNetwork(slow(`net${i}`, 1), { cwd: a }));
    await gitWrite(slow('write', 0), { cwd: repo('b') });
    await Promise.all(network);

    expect(order()[0]).toBe('write');
  });

  test('local writes in one directory run one at a time, in order', async () => {
    const a = repo('a');
    await Promise.all([
      gitWrite(slow('first', 0.4), { cwd: a }),
      gitWrite(slow('second', 0), { cwd: a }),
    ]);
    expect(order()).toEqual(['first', 'second']);
  });

  test('writes in different directories still run in parallel', async () => {
    await Promise.all([
      gitWrite(slow('slow', 0.6), { cwd: repo('a') }),
      gitWrite(slow('fast', 0), { cwd: repo('b') }),
    ]);
    expect(order()).toEqual(['fast', 'slow']);
  });

  test('worktree commands are not queued behind the main checkout', async () => {
    const a = repo('a');
    await Promise.all([
      gitWrite(slow('checkout', 0.6), { cwd: a }),
      gitWrite(['worktree', 'list'], { cwd: a }).then(() =>
        writeFileSync(LOG, `${readFileSync(LOG, 'utf8')}worktree\n`),
      ),
    ]);
    expect(order()).toEqual(['worktree', 'checkout']);
  });

  test('a failed write does not block the next write in that directory', async () => {
    const a = repo('a');
    const failing = gitWrite(['not-a-git-command'], { cwd: a });
    const next = gitWrite(slow('after', 0), { cwd: a });
    await expect(failing).rejects.toThrow();
    await next;
    expect(order()).toEqual(['after']);
  });

  test('network commands bump the write generation like local writes', async () => {
    const before = getGitWriteGeneration();
    await gitNetwork(['--version']);
    expect(getGitWriteGeneration()).toBeGreaterThan(before);
  });

  test('an unauthenticated fetch reports success even though it prints nothing', async () => {
    const remote = repo('remote');
    executeSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], {
      cwd: remote,
      env: {
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
    const local = repo('local');
    executeSync('git', ['remote', 'add', 'origin', remote], { cwd: local });

    const result = await fetchRemote(local);
    expect(result.isOk() && result.value).toBe(true);
  });
});
