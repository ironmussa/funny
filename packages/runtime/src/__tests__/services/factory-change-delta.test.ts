import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
/**
 * The factory step `change-delta` (openspec factory-approval-survives-integration,
 * D2): how a pull request's change differs at two commits, on temporary
 * repositories. A member's approval of one commit follows the change to another
 * only when this says the change is the same (or differs a little).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compareChanges, deltaOf, parseChange } from '../../services/factory-change-delta.js';
import { getFactoryStep, startFactoryStep } from '../../services/factory-steps.js';

let root: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();

const write = (cwd: string, file: string, text: string) => writeFileSync(join(cwd, file), text);

function commit(cwd: string, message: string): string {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

const numbered = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

/**
 * A bare origin with `main`, a clone on `feature` whose change adds a line to
 * `a.txt` (commit A, pushed), and a second clone that pushes to `main`.
 */
function repos() {
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', origin, seed);
  git(seed, 'checkout', '-q', '-b', 'main');
  write(seed, 'a.txt', 'one\ntwo\nthree\n');
  write(seed, 'other.txt', 'x\n');
  commit(seed, 'base');
  git(seed, 'push', '-q', 'origin', 'main');
  const work = join(root, 'work');
  git(root, 'clone', '-q', origin, work);
  git(work, 'config', 'user.name', 'T');
  git(work, 'config', 'user.email', 't@t');
  git(work, 'checkout', '-q', '-b', 'feature');
  write(work, 'a.txt', 'one\ntwo\nthree\nfour\n');
  const a = commit(work, 'feat: four');
  git(work, 'push', '-q', 'origin', 'feature');
  return { seed, work, a };
}

/** Move `main` on the origin, then merge it into `feature`; resolves a conflict with `resolve`. */
function mergeBaseIn(work: string, resolve?: () => void): string {
  git(work, 'fetch', '-q', 'origin', 'main');
  try {
    git(work, 'merge', '-q', '--no-ff', '--no-edit', 'origin/main');
  } catch (error) {
    if (!resolve) throw error;
    resolve();
    git(work, 'add', '-A');
    git(work, '-c', 'core.editor=true', 'commit', '-q', '--no-edit');
  }
  const merged = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', 'origin', 'feature');
  return merged;
}

async function delta(cwd: string, from: string, to: string) {
  const threadId = `t-${Math.random()}`;
  const job = startFactoryStep(threadId, cwd, {
    kind: 'change-delta',
    from,
    to,
    baseBranch: 'main',
    branch: 'feature',
    timeoutMs: 10_000,
  });
  for (let i = 0; i < 200; i++) {
    const current = getFactoryStep(threadId, job.id);
    if (current?.state === 'done' && current.result) {
      if (current.result.kind !== 'change-delta') throw new Error('not a change-delta result');
      return current.result;
    }
    await Bun.sleep(25);
  }
  throw new Error('the step did not finish');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-change-delta-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('change-delta', () => {
  test('a clean merge of the base leaves the change the same, whatever the base brought', async () => {
    const { seed, work, a } = repos();
    // 900 lines of somebody else's work land on the base.
    write(seed, 'big.txt', numbered(900, 'line'));
    commit(seed, 'feat: big');
    git(seed, 'push', '-q', 'origin', 'main');
    const merged = mergeBaseIn(work);

    expect(await delta(work, a, merged)).toMatchObject({
      outcome: 'compared',
      ancestor: true,
      lines: 0,
      files: [],
      outsideFrom: [],
    });
  });

  // What weave or a person does with two additions at the same place: both stay.
  test('a conflict settled by keeping both sides leaves the change the same', async () => {
    const { seed, work, a } = repos();
    write(seed, 'a.txt', 'one\ntwo\nthree\nfive\n');
    commit(seed, 'feat: five');
    git(seed, 'push', '-q', 'origin', 'main');
    const merged = mergeBaseIn(work, () => write(work, 'a.txt', 'one\ntwo\nthree\nfive\nfour\n'));

    expect(await delta(work, a, merged)).toMatchObject({ ancestor: true, lines: 0 });
  });

  test('a commit after the merge counts its lines, in the file it changed', async () => {
    const { seed, work, a } = repos();
    write(seed, 'other.txt', 'x\ny\n');
    commit(seed, 'feat: y');
    git(seed, 'push', '-q', 'origin', 'main');
    mergeBaseIn(work);
    // The change added `four`; now it adds `FOUR` and `six` instead.
    write(work, 'a.txt', 'one\ntwo\nthree\nFOUR\nsix\n');
    const b = commit(work, 'fix: adjust');
    git(work, 'push', '-q', 'origin', 'feature');

    const result = await delta(work, a, b);

    // `four` left the change, `FOUR` and `six` joined it.
    expect(result).toMatchObject({ ancestor: true, lines: 3, outsideFrom: [] });
    expect(result.files).toEqual([{ path: 'a.txt', lines: 3 }]);
  });

  test('a file the earlier change did not touch is named', async () => {
    const { work, a } = repos();
    write(work, 'new.txt', 'hello\n');
    const b = commit(work, 'feat: new file');
    git(work, 'push', '-q', 'origin', 'feature');

    expect(await delta(work, a, b)).toMatchObject({
      lines: 1,
      files: [{ path: 'new.txt', lines: 1 }],
      outsideFrom: ['new.txt'],
    });
  });

  test('a later commit made elsewhere (GitHub updating the branch) is fetched', async () => {
    const { seed, work, a } = repos();
    write(seed, 'other.txt', 'x\ny\n');
    commit(seed, 'feat: y');
    git(seed, 'push', '-q', 'origin', 'main');
    // The merge is made in another clone, as GitHub's update-branch makes it remotely.
    const elsewhere = join(root, 'elsewhere');
    git(root, 'clone', '-q', '-b', 'feature', join(root, 'origin.git'), elsewhere);
    git(elsewhere, 'config', 'user.name', 'T');
    git(elsewhere, 'config', 'user.email', 't@t');
    const merged = mergeBaseIn(elsewhere);

    expect(await delta(work, a, merged)).toMatchObject({ ancestor: true, lines: 0 });
  });

  test('a commit that does not descend from the earlier one is not compared', async () => {
    const { work, a } = repos();
    git(work, 'checkout', '-q', '-B', 'feature', 'origin/main');
    write(work, 'a.txt', 'one\ntwo\nthree\nfour\n');
    const rewritten = commit(work, 'feat: four, rewritten');
    git(work, 'push', '-q', '--force', 'origin', 'feature');

    expect(await delta(work, a, rewritten)).toMatchObject({
      outcome: 'compared',
      ancestor: false,
      lines: 0,
    });
  });

  test('a commit that is not in the checkout fails the step', async () => {
    const { work, a } = repos();
    expect(await delta(work, a, 'f'.repeat(40))).toMatchObject({
      outcome: 'failed',
      ancestor: false,
    });
  });
});

/** Push `files` to `main` from the seed clone. */
function moveBase(seed: string, files: Record<string, string>, remove: string[] = []): void {
  for (const [file, text] of Object.entries(files)) write(seed, file, text);
  for (const file of remove) git(seed, 'rm', '-q', file);
  commit(seed, 'base moves');
  git(seed, 'push', '-q', 'origin', 'main');
}

/** Commit `files` on `feature` and push them. */
function adjust(work: string, files: Record<string, string>): string {
  for (const [file, text] of Object.entries(files)) write(work, file, text);
  const sha = commit(work, 'fix: adjust');
  git(work, 'push', '-q', 'origin', 'feature');
  return sha;
}

// openspec factory-approval-follows-base-code
describe('change-delta and the code the base brought', () => {
  test('a fix of a file the base added is brought by the base', async () => {
    const { seed, work, a } = repos();
    moveBase(seed, { 'new.ts': 'let x: unknown\nkeep\n' });
    mergeBaseIn(work);
    const b = adjust(work, { 'new.ts': 'let x: string\nkeep\n' });

    expect(await delta(work, a, b)).toMatchObject({
      lines: 2,
      outsideFrom: ['new.ts'],
      baseBrought: ['new.ts'],
      linesAcrossMoves: 2,
    });
  });

  test('an edit of a line that was there before the approved commit is not', async () => {
    const { seed, work, a } = repos();
    // The base touches other.txt, but the change rewrites its old line `x`.
    moveBase(seed, { 'other.txt': 'x\nfrom base\n' });
    mergeBaseIn(work);
    const b = adjust(work, { 'other.txt': 'X\nfrom base\n' });

    expect(await delta(work, a, b)).toMatchObject({ outsideFrom: ['other.txt'], baseBrought: [] });
  });

  test('a file the base did not change is not', async () => {
    const { work, a } = repos();
    const b = adjust(work, { 'other.txt': 'y\n' });

    expect(await delta(work, a, b)).toMatchObject({ outsideFrom: ['other.txt'], baseBrought: [] });
  });

  test('an edit that moved with its code when the base split a file does not count', async () => {
    const { seed, work, a } = repos();
    // The base moves `three` (where the change added `four`) out of a.txt into split.txt.
    moveBase(seed, { 'a.txt': 'one\ntwo\n', 'split.txt': 'three\n' });
    // The conflict is settled by carrying the change's edit along with its code.
    const merged = mergeBaseIn(work, () => {
      write(work, 'a.txt', 'one\ntwo\n');
      write(work, 'split.txt', 'three\nfour\n');
    });

    expect(await delta(work, a, merged)).toMatchObject({
      lines: 2,
      outsideFrom: ['split.txt'],
      baseBrought: ['split.txt'],
      linesAcrossMoves: 0,
    });
  });
});

describe('the change a diff describes', () => {
  const diff = (file: string, body: string[]) =>
    [`diff --git a/${file} b/${file}`, 'index 111..222 100644', `--- a/${file}`, `+++ b/${file}`]
      .concat(body)
      .join('\n');

  test('the same lines at other positions are the same change', () => {
    const before = parseChange(diff('a.ts', ['@@ -3 +3 @@', '-old', '+new']));
    const after = parseChange(diff('a.ts', ['@@ -40 +44 @@', '-old', '+new']));
    expect(deltaOf(before, after)).toEqual([]);
  });

  test('a repeated line counts each time', () => {
    const before = parseChange(diff('a.ts', ['@@ -3,0 +4 @@', '+}']));
    const after = parseChange(diff('a.ts', ['@@ -3,0 +4,2 @@', '+}', '+}']));
    expect(deltaOf(before, after)).toEqual([{ path: 'a.ts', lines: 1 }]);
  });

  test('a content line that looks like a file header stays content', () => {
    const before = parseChange(diff('a.md', ['@@ -1 +1 @@', '--- a/x', '+++ b/y']));
    expect([...before.keys()]).toEqual(['a.md']);
    expect(deltaOf(before, parseChange(''))).toEqual([{ path: 'a.md', lines: 2 }]);
  });

  test('a binary file is the same change when it ends as the same blob', () => {
    const binary = (blob: string) =>
      [
        'diff --git a/i.png b/i.png',
        `index 111..${blob} 100644`,
        'Binary files a/i.png and b/i.png differ',
      ].join('\n');
    expect(deltaOf(parseChange(binary('abc')), parseChange(binary('abc')))).toEqual([]);
    expect(deltaOf(parseChange(binary('abc')), parseChange(binary('def')))).toEqual([
      { path: 'i.png', lines: 2 },
    ]);
  });
});

describe('moved edits', () => {
  const change = (files: Record<string, { added?: string[]; removed?: string[] }>) =>
    new Map(
      Object.entries(files).map(([path, { added = [], removed = [] }]) => [
        path,
        {
          added: new Map(added.map((line) => [line, 1])),
          removed: new Map(removed.map((line) => [line, 1])),
        },
      ]),
    );

  test('a line that moves between two files of the approved change still counts', () => {
    const from = change({ 'a.ts': { added: ['edit'] }, 'b.ts': { added: ['other'] } });
    const to = change({ 'a.ts': {}, 'b.ts': { added: ['other', 'edit'] } });

    expect(compareChanges(from, to, new Map())).toMatchObject({ lines: 2, linesAcrossMoves: 2 });
  });

  test('only the moved lines leave the count; a new edit in the same file still counts', () => {
    const from = change({ 'a.ts': { added: ['edit'], removed: ['old'] } });
    const to = change({ 'a.ts': {}, 'g.ts': { added: ['edit', 'extra'], removed: ['old'] } });
    const base = change({ 'g.ts': { added: ['old'] } });

    expect(compareChanges(from, to, base)).toMatchObject({
      lines: 5,
      baseBrought: ['g.ts'],
      linesAcrossMoves: 1,
    });
  });
});
